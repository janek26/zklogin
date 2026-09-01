// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {
    MessageHashUtils
} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {RootVerifier} from "@zkpassport/registry-contracts/RootVerifier.sol";
import {ProofVerificationParams} from "@zkpassport/registry-contracts/lib/Types.sol";
import {
    MockRootVerifier,
    MockVerifierHelper,
    MockPassportInputs,
    NodeKernelCallerV2,
    StrictMockVerifier
} from "./ZkLoginKernelValidatorV2Helpers.sol";
import {
    PackedUserOperation,
    ZkLoginKernelValidatorV2
} from "../src/ZkLoginKernelValidatorV2.sol";

contract ZkLoginKernelValidatorV2Test is Test {
    using MessageHashUtils for bytes32;

    uint256 internal constant FAILED = 1;
    uint256 internal constant ZKP_ACCOUNT_ID = 2;

    StrictMockVerifier internal googleVerifier;
    MockRootVerifier internal zkpVerifier;
    MockVerifierHelper internal zkpHelper;
    ZkLoginKernelValidatorV2 internal validator;
    NodeKernelCallerV2 internal kernel;
    bytes32 internal googleJwkRoot;
    bytes32 internal appId;
    bytes32 internal nullifier;

    uint256 internal proposalOwnerKey = 0xA11CE;
    address internal proposalOwner;
    uint256 internal otherKey = 0xBEEF;
    address internal other;
    uint256 internal sessionKey = 0x5E55;
    address internal sessionAddress;

    address internal kernelAddress;

    function setUp() public {
        googleJwkRoot = keccak256("google-jwk-root");
        appId = keccak256("app-id");
        nullifier = keccak256("passport-nullifier");
        proposalOwner = vm.addr(proposalOwnerKey);
        other = vm.addr(otherKey);
        sessionAddress = vm.addr(sessionKey);

        googleVerifier = new StrictMockVerifier();
        zkpVerifier = new MockRootVerifier();
        zkpHelper = new MockVerifierHelper();
        zkpVerifier.setUniqueIdentifier(nullifier);
        zkpVerifier.setHelper(zkpHelper);

        validator = new ZkLoginKernelValidatorV2(
            googleVerifier, googleJwkRoot, appId, RootVerifier(address(zkpVerifier))
        );
        kernel = new NodeKernelCallerV2();
        kernelAddress = address(kernel);
        kernel.install(validator, bytes32(ZKP_ACCOUNT_ID));
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function ascii(bytes32 binding) internal view returns (string memory) {
        return validator.asciiHex(binding);
    }

    function guardianNonce() internal view returns (uint64) {
        (,,,,, uint64 nonce,,,) = validator.accountState(kernelAddress);
        return nonce;
    }

    function state()
        internal
        view
        returns (ZkLoginKernelValidatorV2.AccountState memory s)
    {
        s = validator.recoveryState(kernelAddress);
    }

    function setGuardianBinding(uint64 guardianNonce) internal view returns (bytes32) {
        (,,,,,, uint64 recoveryNonce,,) = validator.accountState(kernelAddress);
        return keccak256(
            abi.encode(
                validator.RECOVERY_DOMAIN(),
                block.chainid,
                kernelAddress,
                validator.ACTION_SET_GUARDIAN(),
                address(0),
                guardianNonce + 1,
                recoveryNonce
            )
        );
    }

    function proposeBinding(address owner, uint64 recoveryNonce)
        internal
        view
        returns (bytes32)
    {
        (,,,,, uint64 guardianNonce,,,) = validator.accountState(kernelAddress);
        return keccak256(
            abi.encode(
                validator.RECOVERY_DOMAIN(),
                block.chainid,
                kernelAddress,
                validator.ACTION_PROPOSE_RECOVERY(),
                owner,
                guardianNonce,
                recoveryNonce
            )
        );
    }

    /// @dev Configure the mocks so a passport proof with `customData` string
    /// passes every check for the given wallet.
    function armPassport(address wallet, string memory customData) internal {
        zkpVerifier.setValid(true);
        zkpVerifier.setUniqueIdentifier(nullifier);
        zkpHelper.setBoundData(wallet, block.chainid, customData);
        zkpHelper.setScopesOk(true);
        zkpHelper.setFaceMatchOk(true);
    }

    function passportParams(string memory customData)
        internal
        view
        returns (ProofVerificationParams memory)
    {
        return MockPassportInputs.makeParams(
            kernelAddress,
            block.chainid,
            customData,
            false,
            validator.PASSPORT_VALIDITY(),
            validator.PASSPORT_DOMAIN(),
            validator.PASSPORT_SCOPE()
        );
    }

    function expectGuardianSetup(uint48 delay) internal {
        bytes32 binding = setGuardianBinding(state().guardianNonce);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.setGuardian(validator, passportParams(cd), delay);
    }

    function proposalExecutionData(address owner, uint64 nonce)
        internal
        view
        returns (bytes memory)
    {
        ProofVerificationParams memory params =
            passportParams(ascii(proposeBinding(owner, nonce)));
        bytes memory inner =
            abi.encodeCall(validator.proposeRecovery, (params, owner, nonce));
        return abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            bytes32(0),
            abi.encodePacked(address(validator), uint256(0), inner)
        );
    }

    function finalizeExecutionData(uint64 nonce) internal view returns (bytes memory) {
        bytes memory inner = abi.encodeCall(validator.finalizeRecovery, (nonce));
        return abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            bytes32(0),
            abi.encodePacked(address(validator), uint256(0), inner)
        );
    }

    function proposalSignature(address owner, uint64 nonce)
        internal
        view
        returns (bytes memory)
    {
        ProofVerificationParams memory params =
            passportParams(ascii(proposeBinding(owner, nonce)));
        ZkLoginKernelValidatorV2.PassportProposalAuth memory auth;
        auth.params = params;
        auth.proposedOwner = owner;
        auth.recoveryNonce = nonce;
        return abi.encodePacked(bytes1(0x02), abi.encode(auth));
    }

    function finalizeSignature(uint64 nonce, uint256 key, bytes32 userOpHash)
        internal
        view
        returns (bytes memory)
    {
        bytes memory sig = sign(userOpHash, key);
        return abi.encodePacked(bytes1(0x03), abi.encode(nonce, sig));
    }

    function sign(bytes32 userOpHash, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, userOpHash.toEthSignedMessageHash());
        return abi.encodePacked(r, s, v);
    }

    function baseOp(bytes memory callData, bytes memory signature)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return PackedUserOperation({
            sender: kernelAddress,
            nonce: 0,
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32(0),
            preVerificationGas: 0,
            gasFees: bytes32(0),
            paymasterAndData: "",
            signature: signature
        });
    }

    function validate(bytes memory callData, bytes memory signature, bytes32 userOpHash)
        internal
        returns (uint256)
    {
        return kernel.validate(validator, baseOp(callData, signature), userOpHash);
    }

    // ------------------------------------------------------------------
    // Guardian setup / rotation / removal
    // ------------------------------------------------------------------

    function test_acceptsAllAllowedDelays() public {
        uint48[] memory delays = new uint48[](5);
        delays[0] = validator.DELAY_IMMEDIATE();
        delays[1] = validator.DELAY_1_DAY();
        delays[2] = validator.DELAY_3_DAYS();
        delays[3] = validator.DELAY_7_DAYS();
        delays[4] = validator.DELAY_30_DAYS();
        for (uint256 i; i < delays.length; ++i) {
            expectGuardianSetup(delays[i]);
            (,,,, uint48 storedDelay, uint64 nonce,,,) =
                validator.accountState(kernelAddress);
            assertEq(storedDelay, delays[i], "delay must be stored");
            assertEq(nonce, uint64(i * 2 + 1), "guardian nonce must bump");
            kernel.clearGuardian(validator);
        }
    }

    function test_rejectsArbitraryDelay() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        ProofVerificationParams memory params = passportParams(cd);

        vm.expectRevert(bytes("INVALID_DELAY"));
        kernel.setGuardian(validator, params, 2 days);
    }

    function test_rotationReplacesGuardianAndBumpsNonce() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        assertEq(state().guardianNonce, 1);

        bytes32 rotatedNullifier = keccak256("rotated-nullifier");
        bytes32 binding = setGuardianBinding(1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        zkpVerifier.setUniqueIdentifier(rotatedNullifier);
        kernel.setGuardian(validator, passportParams(cd), validator.DELAY_1_DAY());

        (,,, bytes32 stored, uint48 storedDelay, uint64 nonce,,,) =
            validator.accountState(kernelAddress);
        assertEq(stored, rotatedNullifier, "rotation must overwrite nullifier");
        assertEq(storedDelay, validator.DELAY_1_DAY(), "rotation must overwrite delay");
        assertEq(nonce, 2, "rotation must bump guardian nonce");
    }

    function test_removalClearsGuardian() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        kernel.clearGuardian(validator);
        (,,,, uint48 storedDelay, uint64 nonce,,,) =
            validator.accountState(kernelAddress);
        assertEq(state().guardianNullifier, bytes32(0));
        assertEq(storedDelay, 0);
        assertEq(nonce, 2, "removal must bump guardian nonce");
    }

    function test_noGuardianChangesWhileProposalActive() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);

        bytes32 setup = setGuardianBinding(state().guardianNonce);
        string memory setupCd = ascii(setup);
        armPassport(kernelAddress, setupCd);
        ProofVerificationParams memory params = passportParams(setupCd);
        uint48 delay = validator.DELAY_1_DAY();

        vm.expectRevert(bytes("ACTIVE_PROPOSAL"));
        kernel.setGuardian(validator, params, delay);

        vm.expectRevert(bytes("ACTIVE_PROPOSAL"));
        kernel.clearGuardian(validator);
    }

    // ------------------------------------------------------------------
    // ZKPassport rejection matrix
    // ------------------------------------------------------------------

    function test_rejectsInvalidProof() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        zkpVerifier.setValid(false);
        ProofVerificationParams memory params = passportParams(cd);
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("INVALID_PROOF"));
        kernel.setGuardian(validator, params, delay);
    }

    function test_rejectsMockNullifierInDevMode() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        ProofVerificationParams memory params = passportParams(cd);
        params.serviceConfig.devMode = true;
        // devMode=true is allowed for real passports, but the Sepolia registry
        // contains ZKR mock certs, so both mock nullifier types must stay rejected.
        params.proofVerificationData
        .publicInputs[
            params.proofVerificationData.publicInputs.length - 3
        ] = bytes32(uint256(2)); // NON_SALTED_MOCK_NULLIFIER
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("MOCK_PROOF"));
        kernel.setGuardian(validator, params, delay);

        // SALTED_MOCK_NULLIFIER (3) must be rejected too.
        params.proofVerificationData
        .publicInputs[
            params.proofVerificationData.publicInputs.length - 3
        ] = bytes32(uint256(3));
        vm.expectRevert(bytes("MOCK_PROOF"));
        kernel.setGuardian(validator, params, delay);
    }

    function test_acceptsRealPassportInDevMode() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        ProofVerificationParams memory params = passportParams(cd);
        params.serviceConfig.devMode = true;
        // NON_SALTED_NULLIFIER (0) is a real passport — must be accepted.
        params.proofVerificationData
        .publicInputs[
            params.proofVerificationData.publicInputs.length - 3
        ] = bytes32(uint256(0));
        uint48 delay = validator.DELAY_7_DAYS();

        kernel.setGuardian(validator, params, delay);

        (,,, bytes32 stored,, uint64 nonce,,,) = validator.accountState(kernelAddress);
        assertEq(stored, nullifier, "real devMode passport must set guardian");
        assertEq(nonce, 1, "guardian nonce must bump");
    }

    function test_rejectsWrongDomain() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        ProofVerificationParams memory params = passportParams(cd);
        params.serviceConfig.domain = "evil.example";
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("DOMAIN"));
        kernel.setGuardian(validator, params, delay);
    }

    function test_rejectsWrongScope() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        ProofVerificationParams memory params = passportParams(cd);
        params.serviceConfig.scope = "policy-9:9";
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("SCOPE"));
        kernel.setGuardian(validator, params, delay);
    }

    function test_rejectsWrongValidity() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        ProofVerificationParams memory params = passportParams(cd);
        params.serviceConfig.validityPeriodInSeconds = 1 days;
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("VALIDITY"));
        kernel.setGuardian(validator, params, delay);
    }

    function test_rejectsWrongSenderBinding() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(other, cd);
        ProofVerificationParams memory params = passportParams(cd);
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("SENDER_MISMATCH"));
        kernel.setGuardian(validator, params, delay);
    }

    function test_rejectsWrongChainBinding() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        zkpHelper.setBoundData(kernelAddress, block.chainid + 1, cd);
        ProofVerificationParams memory params = passportParams(cd);
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("CHAIN_MISMATCH"));
        kernel.setGuardian(validator, params, delay);
    }

    function test_rejectsWrongCustomData() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(
            kernelAddress,
            "0x0000000000000000000000000000000000000000000000000000000000000000"
        );
        ProofVerificationParams memory params = passportParams(cd);
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("BINDING_MISMATCH"));
        kernel.setGuardian(validator, params, delay);
    }

    function test_rejectsHelperScopeMismatch() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        zkpHelper.setScopesOk(false);
        ProofVerificationParams memory params = passportParams(cd);
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("SCOPE_MISMATCH"));
        kernel.setGuardian(validator, params, delay);
    }

    function test_rejectsFaceMatchFailure() public {
        bytes32 binding = setGuardianBinding(0);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        zkpHelper.setFaceMatchOk(false);
        ProofVerificationParams memory params = passportParams(cd);
        uint48 delay = validator.DELAY_7_DAYS();

        vm.expectRevert(bytes("FACE_MATCH"));
        kernel.setGuardian(validator, params, delay);
    }

    // ------------------------------------------------------------------
    // Proposal + deadlines
    // ------------------------------------------------------------------

    function test_proposalDeadlineForEveryDelay() public {
        uint48[] memory delays = new uint48[](5);
        delays[0] = validator.DELAY_1_DAY();
        delays[1] = validator.DELAY_3_DAYS();
        delays[2] = validator.DELAY_7_DAYS();
        delays[3] = validator.DELAY_30_DAYS();
        delays[4] = validator.DELAY_IMMEDIATE();
        for (uint256 i; i < delays.length; ++i) {
            vm.warp(1_700_000_000 + uint256(i) * 1_000);
            // Fresh kernel per delay so recoveryNonce starts at zero.
            kernel = new NodeKernelCallerV2();
            kernelAddress = address(kernel);
            kernel.install(validator, bytes32(ZKP_ACCOUNT_ID + uint256(i)));
            expectGuardianSetup(delays[i]);
            uint256 before = block.timestamp;
            bytes32 binding = proposeBinding(proposalOwner, 1);
            string memory cd = ascii(binding);
            armPassport(kernelAddress, cd);
            kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
            ZkLoginKernelValidatorV2.RecoveryProposal memory proposal = state().recovery;
            assertEq(proposal.proposedOwner, proposalOwner);
            assertEq(
                proposal.executableAt,
                before + delays[i],
                "executableAt must be proposalTime + delay"
            );
            assertEq(proposal.nonce, 1);
            assertEq(state().recoveryNonce, 1);

            // Immediate has no dependable cancellation window, so only the
            // non-immediate delays test replacement + cancel + reset.
            if (delays[i] > 0) {
                bytes32 binding2 = proposeBinding(proposalOwner, 2);
                string memory cd2 = ascii(binding2);
                armPassport(kernelAddress, cd2);
                kernel.proposeRecovery(validator, passportParams(cd2), proposalOwner, 2);

                kernel.cancelRecovery(validator); // replacement proposal is still live
                kernel.clearGuardian(validator); // reset for next delay
            }
        }
    }

    function test_proposalRejectsWrongNonce() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 5);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        ProofVerificationParams memory params = passportParams(cd);

        vm.expectRevert(bytes("INVALID_RECOVERY_NONCE"));
        kernel.proposeRecovery(validator, params, proposalOwner, 5);
    }

    function test_proposalRejectsNonEOA() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(address(zkpVerifier), 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        ProofVerificationParams memory params = passportParams(cd);

        vm.expectRevert(bytes("INVALID_PROPOSED_OWNER"));
        kernel.proposeRecovery(validator, params, address(zkpVerifier), 1);
    }

    function test_proposalRejectsGuardianMismatch() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        zkpVerifier.setUniqueIdentifier(keccak256("someone-else"));
        ProofVerificationParams memory params = passportParams(cd);

        vm.expectRevert(bytes("GUARDIAN_MISMATCH"));
        kernel.proposeRecovery(validator, params, proposalOwner, 1);
    }

    // ------------------------------------------------------------------
    // Mode 0x02: exact proposal validation
    // ------------------------------------------------------------------

    function test_mode02AcceptsExactProposal() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());

        armPassport(kernelAddress, ascii(proposeBinding(proposalOwner, 1)));
        bytes memory callData = proposalExecutionData(proposalOwner, 1);
        bytes memory sig = proposalSignature(proposalOwner, 1);
        assertEq(
            validate(callData, sig, keccak256("proposal-op")),
            0,
            "exact proposal must validate"
        );
    }

    function test_mode02RejectsChangedOwner() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());

        armPassport(kernelAddress, ascii(proposeBinding(proposalOwner, 1)));
        bytes memory callData = proposalExecutionData(proposalOwner, 1);
        bytes memory sig = proposalSignature(other, 1);
        assertEq(
            validate(callData, sig, keccak256("proposal-op")),
            FAILED,
            "owner change must fail"
        );
    }

    function test_mode02RejectsChangedNonce() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());

        armPassport(kernelAddress, ascii(proposeBinding(proposalOwner, 1)));
        bytes memory callData = proposalExecutionData(proposalOwner, 1);
        bytes memory sig = proposalSignature(proposalOwner, 2);
        assertEq(
            validate(callData, sig, keccak256("proposal-op")),
            FAILED,
            "nonce change must fail"
        );
    }

    function test_mode02RejectsArbitraryCallData() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());

        armPassport(kernelAddress, ascii(proposeBinding(proposalOwner, 1)));
        bytes memory sig = proposalSignature(proposalOwner, 1);
        bytes memory callData = abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            bytes32(0),
            abi.encodePacked(address(0xBEEF), uint256(1 ether), hex"")
        );
        assertEq(
            validate(callData, sig, keccak256("proposal-op")),
            FAILED,
            "arbitrary call must fail"
        );
    }

    function test_mode02RejectsChangedBinding() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());

        bytes32 binding = setGuardianBinding(state().guardianNonce);
        string memory cd = ascii(binding);
        ProofVerificationParams memory params = passportParams(cd);
        ZkLoginKernelValidatorV2.PassportProposalAuth memory auth;
        auth.params = params;
        auth.proposedOwner = proposalOwner;
        auth.recoveryNonce = 1;
        bytes memory sig = abi.encodePacked(bytes1(0x02), abi.encode(auth));
        bytes memory callData = proposalExecutionData(proposalOwner, 1);
        assertEq(
            validate(callData, sig, keccak256("proposal-op")),
            FAILED,
            "wrong binding must fail"
        );
    }

    function test_mode02RejectsInvalidProof() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());

        armPassport(kernelAddress, ascii(proposeBinding(proposalOwner, 1)));
        bytes memory callData = proposalExecutionData(proposalOwner, 1);
        bytes memory sig = proposalSignature(proposalOwner, 1);
        zkpVerifier.setValid(false);
        assertEq(
            validate(callData, sig, keccak256("proposal-op")),
            FAILED,
            "invalid proof must fail"
        );
    }

    function test_mode02RejectsWrongWallet() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());

        armPassport(kernelAddress, ascii(proposeBinding(proposalOwner, 1)));
        bytes memory callData = proposalExecutionData(proposalOwner, 1);
        bytes memory sig = proposalSignature(proposalOwner, 1);
        zkpHelper.setBoundData(
            other, block.chainid, ascii(proposeBinding(proposalOwner, 1))
        );
        assertEq(
            validate(callData, sig, keccak256("proposal-op")),
            FAILED,
            "wallet change must fail"
        );
    }

    // ------------------------------------------------------------------
    // Mode 0x03: finalization
    // ------------------------------------------------------------------

    function test_mode03RejectsBeforeDeadline() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;

        vm.warp(executableAt - 1);
        bytes memory callData = finalizeExecutionData(1);
        bytes memory sig =
            finalizeSignature(1, proposalOwnerKey, keccak256("finalize-op"));
        assertEq(
            validate(callData, sig, keccak256("finalize-op")),
            FAILED,
            "before deadline must fail"
        );

        vm.expectRevert(bytes("NOT_EXECUTABLE"));
        kernel.finalizeRecovery(validator, 1);
    }

    function test_mode03AcceptsAtDeadlineAndFinalizes() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;

        vm.warp(executableAt);
        bytes memory callData = finalizeExecutionData(1);
        bytes memory sig =
            finalizeSignature(1, proposalOwnerKey, keccak256("finalize-op"));
        assertEq(
            validate(callData, sig, keccak256("finalize-op")),
            0,
            "at deadline must validate"
        );
        kernel.finalizeRecovery(validator, 1);

        assertEq(state().permanentOwner, proposalOwner);
        address owner = state().recovery.proposedOwner;
        assertEq(owner, address(0), "proposal must be cleared");
    }

    function test_mode03RejectsWrongKey() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt);

        bytes memory callData = finalizeExecutionData(1);
        bytes memory sig = finalizeSignature(1, otherKey, keccak256("finalize-op"));
        assertEq(
            validate(callData, sig, keccak256("finalize-op")),
            FAILED,
            "wrong key must fail"
        );
    }

    function test_mode03RejectsWrongNonce() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt);

        bytes memory callData = finalizeExecutionData(1);
        bytes memory sig =
            finalizeSignature(2, proposalOwnerKey, keccak256("finalize-op"));
        assertEq(
            validate(callData, sig, keccak256("finalize-op")),
            FAILED,
            "nonce change must fail"
        );
    }

    function test_mode03RejectsArbitraryCallData() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt);

        bytes memory sig =
            finalizeSignature(1, proposalOwnerKey, keccak256("finalize-op"));
        bytes memory callData = abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            bytes32(0),
            abi.encodePacked(address(0xBEEF), uint256(1 ether), hex"")
        );
        assertEq(
            validate(callData, sig, keccak256("finalize-op")),
            FAILED,
            "arbitrary call must fail"
        );
    }

    function test_mode03RejectsAfterProposalCleared() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;

        vm.warp(executableAt - 1);
        kernel.cancelRecovery(validator);
        vm.warp(executableAt);
        bytes memory callData = finalizeExecutionData(1);
        bytes memory sig =
            finalizeSignature(1, proposalOwnerKey, keccak256("finalize-op"));
        assertEq(
            validate(callData, sig, keccak256("finalize-op")),
            FAILED,
            "cleared proposal must fail"
        );
    }

    // ------------------------------------------------------------------
    // Cancellation
    // ------------------------------------------------------------------

    function test_cancelBeforeDeadline() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt - 1);

        kernel.cancelRecovery(validator);
        address owner = state().recovery.proposedOwner;
        assertEq(owner, address(0), "cancellation must clear the proposal");
    }

    function test_cancelAfterDeadlineRejected() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt);

        vm.expectRevert(bytes("DEADLINE_PASSED"));
        kernel.cancelRecovery(validator);
    }

    function test_cancelPlusClearBatch() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt - 1);

        kernel.cancelRecovery(validator);
        kernel.clearGuardian(validator);
        assertEq(state().guardianNullifier, bytes32(0));
        address owner = state().recovery.proposedOwner;
        assertEq(owner, address(0));
    }

    function test_immediateHasNoCancellationWindow() public {
        expectGuardianSetup(validator.DELAY_IMMEDIATE());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        assertEq(
            executableAt, block.timestamp, "immediate proposal is executable at once"
        );

        vm.expectRevert(bytes("DEADLINE_PASSED"));
        kernel.cancelRecovery(validator);

        vm.warp(executableAt);
        kernel.finalizeRecovery(validator, 1);
        assertEq(state().permanentOwner, proposalOwner);
    }

    // ------------------------------------------------------------------
    // Mode 0x04 + post-finalization lockdown
    // ------------------------------------------------------------------

    function test_mode04PermanentOwnerSignsNormalOps() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt);
        kernel.finalizeRecovery(validator, 1);

        bytes32 opHash = keccak256("owner-op");
        bytes memory sig =
            abi.encodePacked(bytes1(0x04), sign(opHash, proposalOwnerKey));
        bytes memory callData = abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            bytes32(0),
            abi.encodePacked(address(0xBEEF), uint256(0), hex"")
        );
        assertEq(
            validate(callData, sig, opHash),
            0,
            "permanent owner mode 0x04 must validate"
        );
    }

    function test_mode04RejectsWrongKey() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt);
        kernel.finalizeRecovery(validator, 1);

        bytes32 opHash = keccak256("owner-op");
        bytes memory sig = abi.encodePacked(bytes1(0x04), sign(opHash, otherKey));
        assertEq(
            validate(hex"deadbeef", sig, opHash),
            FAILED,
            "wrong permanent key must fail"
        );
    }

    function test_sessionModeWorksBeforeFinalization() public {
        kernel.activate(
            validator, sessionAddress, uint48(block.timestamp + 3600), keccak256("r")
        );
        bytes32 opHash = keccak256("session-op");
        bytes memory sig = abi.encodePacked(bytes1(0x01), sign(opHash, sessionKey));
        uint256 expected = uint256(uint48(block.timestamp + 3600)) << 160;
        assertEq(
            validate(hex"deadbeef", sig, opHash),
            expected,
            "session mode must validate before finalization"
        );
    }

    function test_googleAndSessionRejectedAfterFinalization() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt);
        kernel.finalizeRecovery(validator, 1);

        vm.expectRevert(bytes("FINALIZED"));
        kernel.activate(
            validator, sessionAddress, uint48(block.timestamp + 3600), keccak256("r2")
        );
        bytes32 opHash = keccak256("session-op-after");
        bytes memory sig = abi.encodePacked(bytes1(0x01), sign(opHash, sessionKey));
        assertEq(
            validate(hex"deadbeef", sig, opHash),
            FAILED,
            "session mode must reject after finalization"
        );

        bytes memory proofSig = abi.encodePacked(bytes1(0x00), hex"deadbeef");
        assertEq(
            validate(hex"deadbeef", proofSig, opHash),
            FAILED,
            "proof mode must reject after finalization"
        );
    }

    function test_guardianManagementRejectedAfterFinalization() public {
        expectGuardianSetup(validator.DELAY_7_DAYS());
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        kernel.proposeRecovery(validator, passportParams(cd), proposalOwner, 1);
        uint48 executableAt = state().recovery.executableAt;
        vm.warp(executableAt);
        kernel.finalizeRecovery(validator, 1);

        bytes32 setup = setGuardianBinding(state().guardianNonce);
        string memory setupCd = ascii(setup);
        armPassport(kernelAddress, setupCd);
        ProofVerificationParams memory params = passportParams(setupCd);
        uint48 delay = validator.DELAY_1_DAY();

        vm.expectRevert(bytes("FINALIZED"));
        kernel.setGuardian(validator, params, delay);
        vm.expectRevert(bytes("FINALIZED"));
        kernel.clearGuardian(validator);
        vm.expectRevert(bytes("FINALIZED"));
        kernel.cancelRecovery(validator);
        vm.expectRevert(bytes("FINALIZED"));
        kernel.activate(
            validator, sessionAddress, uint48(block.timestamp + 3600), keccak256("r3")
        );
    }

    // ------------------------------------------------------------------
    // Unauthorized wallet / no guardian
    // ------------------------------------------------------------------

    function test_unknownKernelRejected() public {
        NodeKernelCallerV2 rogue = new NodeKernelCallerV2();
        bytes memory callData = finalizeExecutionData(1);
        bytes memory sig = finalizeSignature(1, proposalOwnerKey, keccak256("op"));
        assertEq(
            rogue.validate(validator, baseOp(callData, sig), keccak256("op")), FAILED
        );
    }

    function test_proposalWithoutGuardianRejected() public {
        bytes32 binding = proposeBinding(proposalOwner, 1);
        string memory cd = ascii(binding);
        armPassport(kernelAddress, cd);
        ProofVerificationParams memory params = passportParams(cd);

        vm.expectRevert(bytes("NO_GUARDIAN"));
        kernel.proposeRecovery(validator, params, proposalOwner, 1);
    }
}
