// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {
    MessageHashUtils
} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {RootVerifier} from "@zkpassport/registry-contracts/RootVerifier.sol";
import {VerifierHelper} from "@zkpassport/registry-contracts/VerifierHelper.sol";
import {
    BoundData,
    FaceMatchMode,
    OS,
    ProofVerificationParams
} from "@zkpassport/registry-contracts/lib/Types.sol";

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IValidator {
    error AlreadyInitialized(address smartAccount);
    error NotInitialized(address smartAccount);
    function onInstall(bytes calldata data) external payable;
    function onUninstall(bytes calldata data) external payable;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
    function isInitialized(address smartAccount) external view returns (bool);
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        payable
        returns (uint256);
    function isValidSignatureWithSender(
        address sender,
        bytes32 hash,
        bytes calldata data
    ) external view returns (bytes4);
}

interface IProofVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs)
        external
        view
        returns (bool);
}

/// @notice V2 root validator: existing Google/session modes plus self-passport
/// guardian recovery with a user-selected delay. See RECOVERY_PLAN.md.
/// The ZKPassport proof verifies exactly twice for a proposal: once in
/// signature validation (invalid proofs never reach sponsored execution) and
/// once in exact execution before state changes.
contract ZkLoginKernelValidatorV2 is IValidator {
    using MessageHashUtils for bytes32;
    uint256 internal constant MODULE_TYPE_VALIDATOR = 1;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;
    bytes4 internal constant KERNEL_EXECUTE_SELECTOR =
        bytes4(keccak256("execute(bytes32,bytes)"));
    bytes32 public constant SESSION_DOMAIN = keccak256("ZKLOGIN_KERNEL_SESSION_V1");
    uint48 public constant PROOF_WINDOW = 10 minutes;
    uint48 public constant CLOCK_SKEW = 5 minutes;
    uint48 public constant MAX_SESSION = 24 hours;

    string public constant PASSPORT_DOMAIN = "zklogin-poc.rahrt.com";
    string public constant PASSPORT_SCOPE = "policy-1:1";
    uint256 public constant PASSPORT_VALIDITY = 7 days;
    bytes32 public constant RECOVERY_DOMAIN = keccak256("ZKLOGIN_PASSPORT_RECOVERY_V2");
    bytes32 public constant ACTION_SET_GUARDIAN = keccak256("SET_GUARDIAN");
    bytes32 public constant ACTION_PROPOSE_RECOVERY = keccak256("PROPOSE_RECOVERY");
    uint48 public constant DELAY_IMMEDIATE = 0;
    uint48 public constant DELAY_1_DAY = 1 days;
    uint48 public constant DELAY_3_DAYS = 3 days;
    uint48 public constant DELAY_7_DAYS = 7 days;
    uint48 public constant DELAY_30_DAYS = 30 days;

    IProofVerifier public immutable googleProofVerifier;
    bytes32 public immutable googleJwkRoot;
    bytes32 public immutable appId;
    RootVerifier public immutable zkPassportVerifier;

    struct RecoveryProposal {
        address proposedOwner;
        uint48 executableAt;
        uint64 nonce;
    }

    struct AccountState {
        bytes32 accountId;
        address sessionKey;
        uint48 sessionValidUntil;
        bytes32 guardianNullifier;
        uint48 recoveryDelay;
        uint64 guardianNonce;
        uint64 recoveryNonce;
        address permanentOwner;
        RecoveryProposal recovery;
    }

    struct ProofAuth {
        bytes proof;
        uint64 jwtIat;
        bytes32 publicKeyHash;
        bytes32[] jwkProof;
        address sessionKey;
        uint48 sessionValidUntil;
        bytes32 randomness;
        bytes sessionSignature;
    }

    /// @dev Payload inside the mode-0x02 UserOperation signature. Contains the
    /// full passport params so validation can re-run every passport check
    /// before the paymaster accepts the operation.
    struct PassportProposalAuth {
        ProofVerificationParams params;
        address proposedOwner;
        uint64 recoveryNonce;
    }

    mapping(address kernel => AccountState) public accountState;

    /// @dev Test/UI convenience: the public mapping getter ABI-encodes the
    /// struct as a flat 9-tuple. This view returns the same data typed as the
    /// struct so callers can destructure it without via-ir.
    function recoveryState(address kernel) external view returns (AccountState memory) {
        return accountState[kernel];
    }
    event AccountInstalled(address indexed kernel, bytes32 indexed accountId);
    event SessionActivated(
        address indexed kernel, address indexed sessionKey, uint48 validUntil
    );
    event GuardianSet(
        address indexed kernel, bytes32 indexed nullifier, uint48 delay, uint64 nonce
    );
    event GuardianCleared(address indexed kernel, uint64 nonce);
    event RecoveryProposed(
        address indexed kernel,
        address indexed proposedOwner,
        uint48 executableAt,
        uint64 nonce
    );
    event RecoveryCancelled(address indexed kernel);
    event RecoveryFinalized(address indexed kernel, address indexed permanentOwner);

    constructor(
        IProofVerifier googleProofVerifier_,
        bytes32 googleJwkRoot_,
        bytes32 appId_,
        RootVerifier zkPassportVerifier_
    ) {
        require(address(googleProofVerifier_) != address(0), "ZERO_VERIFIER");
        require(googleJwkRoot_ != bytes32(0), "ZERO_JWK_ROOT");
        require(appId_ != bytes32(0), "ZERO_APP_ID");
        require(address(zkPassportVerifier_) != address(0), "ZERO_ZKP_VERIFIER");
        googleProofVerifier = googleProofVerifier_;
        googleJwkRoot = googleJwkRoot_;
        appId = appId_;
        zkPassportVerifier = zkPassportVerifier_;
    }

    function onInstall(bytes calldata data) external payable override {
        if (accountState[msg.sender].accountId != bytes32(0)) {
            revert AlreadyInitialized(msg.sender);
        }
        bytes32 accountId_ = abi.decode(data, (bytes32));
        require(accountId_ != bytes32(0), "ZERO_ACCOUNT_ID");
        accountState[msg.sender].accountId = accountId_;
        emit AccountInstalled(msg.sender, accountId_);
    }

    function onUninstall(bytes calldata) external payable override {
        if (accountState[msg.sender].accountId == bytes32(0)) {
            revert NotInitialized(msg.sender);
        }
        delete accountState[msg.sender];
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function isInitialized(address smartAccount) external view override returns (bool) {
        return accountState[smartAccount].accountId != bytes32(0);
    }

    function isValidSignatureWithSender(address, bytes32, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return ERC1271_INVALID;
    }

    function sessionNonce(address sessionKey, uint48 validUntil, bytes32 randomness)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                SESSION_DOMAIN,
                block.chainid,
                address(this),
                appId,
                sessionKey,
                validUntil,
                randomness
            )
        );
    }

    function activateSession(address sessionKey, uint48 validUntil, bytes32) external {
        AccountState storage state = accountState[msg.sender];
        if (state.accountId == bytes32(0)) revert NotInitialized(msg.sender);
        require(state.permanentOwner == address(0), "FINALIZED");
        require(sessionKey != address(0), "ZERO_SESSION_KEY");
        require(validUntil >= block.timestamp, "SESSION_ALREADY_EXPIRED");
        state.sessionKey = sessionKey;
        state.sessionValidUntil = validUntil;
        emit SessionActivated(msg.sender, sessionKey, validUntil);
    }

    // ---------------------------------------------------------------------
    // Guardian recovery API (all functions execute through Kernel.execute, so
    // msg.sender is the installed Kernel; mode 0x00/0x01 authorization).
    // ---------------------------------------------------------------------

    function setGuardian(ProofVerificationParams calldata params, uint48 delay)
        external
    {
        AccountState storage state = accountState[msg.sender];
        if (state.accountId == bytes32(0)) revert NotInitialized(msg.sender);
        require(state.permanentOwner == address(0), "FINALIZED");
        require(_isAllowedDelay(delay), "INVALID_DELAY");
        require(state.recovery.proposedOwner == address(0), "ACTIVE_PROPOSAL");
        bytes32 binding = _binding(
            ACTION_SET_GUARDIAN,
            address(0),
            state.guardianNonce + 1,
            state.recoveryNonce
        );
        bytes32 nullifier = _verifyPassport(params, msg.sender, binding);
        state.guardianNullifier = nullifier;
        state.recoveryDelay = delay;
        state.guardianNonce += 1;
        emit GuardianSet(msg.sender, nullifier, delay, state.guardianNonce);
    }

    function clearGuardian() external {
        AccountState storage state = accountState[msg.sender];
        if (state.accountId == bytes32(0)) revert NotInitialized(msg.sender);
        require(state.permanentOwner == address(0), "FINALIZED");
        require(state.recovery.proposedOwner == address(0), "ACTIVE_PROPOSAL");
        state.guardianNullifier = bytes32(0);
        state.recoveryDelay = 0;
        state.guardianNonce += 1;
        emit GuardianCleared(msg.sender, state.guardianNonce);
    }

    /// @notice Clears the proposal only. Callable before the non-immediate
    /// deadline; Immediate proposals are executable immediately, so they have
    /// no dependable cancellation window.
    function cancelRecovery() external {
        AccountState storage state = accountState[msg.sender];
        if (state.accountId == bytes32(0)) revert NotInitialized(msg.sender);
        require(state.permanentOwner == address(0), "FINALIZED");
        RecoveryProposal memory proposal = state.recovery;
        require(proposal.proposedOwner != address(0), "NO_PROPOSAL");
        require(block.timestamp < proposal.executableAt, "DEADLINE_PASSED");
        delete state.recovery;
        emit RecoveryCancelled(msg.sender);
    }

    function proposeRecovery(
        ProofVerificationParams calldata params,
        address proposedOwner,
        uint64 recoveryNonce
    ) external {
        AccountState storage state = accountState[msg.sender];
        if (state.accountId == bytes32(0)) revert NotInitialized(msg.sender);
        require(state.permanentOwner == address(0), "FINALIZED");
        require(state.guardianNullifier != bytes32(0), "NO_GUARDIAN");
        require(
            proposedOwner != address(0) && proposedOwner.code.length == 0,
            "INVALID_PROPOSED_OWNER"
        );
        require(recoveryNonce == state.recoveryNonce + 1, "INVALID_RECOVERY_NONCE");
        bytes32 binding = _binding(
            ACTION_PROPOSE_RECOVERY, proposedOwner, state.guardianNonce, recoveryNonce
        );
        bytes32 nullifier = _verifyPassport(params, msg.sender, binding);
        require(nullifier == state.guardianNullifier, "GUARDIAN_MISMATCH");
        uint48 executableAt = uint48(block.timestamp) + state.recoveryDelay;
        state.recovery = RecoveryProposal({
            proposedOwner: proposedOwner,
            executableAt: executableAt,
            nonce: recoveryNonce
        });
        state.recoveryNonce = recoveryNonce;
        emit RecoveryProposed(msg.sender, proposedOwner, executableAt, recoveryNonce);
    }

    function finalizeRecovery(uint64 recoveryNonce) external {
        AccountState storage state = accountState[msg.sender];
        if (state.accountId == bytes32(0)) revert NotInitialized(msg.sender);
        RecoveryProposal memory proposal = state.recovery;
        require(proposal.proposedOwner != address(0), "NO_PROPOSAL");
        require(proposal.nonce == recoveryNonce, "NONCE_MISMATCH");
        require(block.timestamp >= proposal.executableAt, "NOT_EXECUTABLE");
        state.permanentOwner = proposal.proposedOwner;
        delete state.recovery;
        emit RecoveryFinalized(msg.sender, proposal.proposedOwner);
    }

    function _isAllowedDelay(uint48 delay) internal pure returns (bool) {
        return delay == DELAY_IMMEDIATE || delay == DELAY_1_DAY || delay == DELAY_3_DAYS
            || delay == DELAY_7_DAYS || delay == DELAY_30_DAYS;
    }

    // ---------------------------------------------------------------------
    // ZKPassport verification
    // ---------------------------------------------------------------------

    /// @dev Reverts on any failure; returns the pseudonymous unique identifier.
    /// Never accepts a caller-controlled domain, scope, validity, chain, or
    /// bound wallet.
    function _verifyPassport(
        ProofVerificationParams calldata params,
        address kernel,
        bytes32 expectedBinding
    ) internal view returns (bytes32) {
        // devMode=true selects the Sepolia certificate registry in the ZKPassport
        // SDK, but mock-passport nullifiers must stay rejected: the Sepolia registry
        // contains ZKR mock certs, so devMode must not unlock mock guardians.
        if (params.serviceConfig.devMode) {
            uint256 nullifierType = uint256(
                params.proofVerificationData.publicInputs[params.proofVerificationData.publicInputs.length - 3]
            );
            require(
                nullifierType != 2 && nullifierType != 3,
                "MOCK_PROOF"
            );
        }
        require(
            params.serviceConfig.validityPeriodInSeconds == PASSPORT_VALIDITY,
            "VALIDITY"
        );
        require(
            keccak256(bytes(params.serviceConfig.domain))
                == keccak256(bytes(PASSPORT_DOMAIN)),
            "DOMAIN"
        );
        require(
            keccak256(bytes(params.serviceConfig.scope))
                == keccak256(bytes(PASSPORT_SCOPE)),
            "SCOPE"
        );
        (bool valid, bytes32 uniqueIdentifier, VerifierHelper helper) =
            zkPassportVerifier.verify(params);
        require(valid, "INVALID_PROOF");
        require(
            helper.verifyScopes(
                params.proofVerificationData.publicInputs,
                PASSPORT_DOMAIN,
                PASSPORT_SCOPE
            ),
            "SCOPE_MISMATCH"
        );
        BoundData memory boundData = helper.getBoundData(params.committedInputs);
        require(boundData.senderAddress == kernel, "SENDER_MISMATCH");
        require(boundData.chainId == block.chainid, "CHAIN_MISMATCH");
        require(
            keccak256(bytes(boundData.customData))
                == keccak256(bytes(_asciiHex(expectedBinding))),
            "BINDING_MISMATCH"
        );
        require(
            helper.isFaceMatchVerified(
                FaceMatchMode.STRICT, OS.ANY, params.committedInputs
            ),
            "FACE_MATCH"
        );
        return uniqueIdentifier;
    }

    /// @dev External wrapper so validation can try/catch the same checks.
    function verifyPassport(
        ProofVerificationParams calldata params,
        address kernel,
        bytes32 expectedBinding
    ) external view returns (bytes32) {
        return _verifyPassport(params, kernel, expectedBinding);
    }

    function _binding(
        bytes32 action,
        address proposedOwner,
        uint64 guardianNonce,
        uint64 recoveryNonce
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                RECOVERY_DOMAIN,
                block.chainid,
                msg.sender,
                action,
                proposedOwner,
                guardianNonce,
                recoveryNonce
            )
        );
    }

    /// @dev Public for test/frontend parity: the canonical custom_data string
    /// both sides must produce for a binding hash.
    function asciiHex(bytes32 value) public pure returns (string memory) {
        return _asciiHex(value);
    }

    function _asciiHex(bytes32 value) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < 32; ++i) {
            uint8 b = uint8(value[i]);
            out[2 + i * 2] = hexChars[b >> 4];
            out[3 + i * 2] = hexChars[b & 0x0f];
        }
        return string(out);
    }

    // ---------------------------------------------------------------------
    // validateUserOp
    // ---------------------------------------------------------------------

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        payable
        override
        returns (uint256)
    {
        if (userOp.sender != msg.sender || userOp.signature.length < 1) {
            return SIG_VALIDATION_FAILED;
        }
        AccountState storage state = accountState[msg.sender];
        if (state.accountId == bytes32(0)) return SIG_VALIDATION_FAILED;
        uint8 mode = uint8(userOp.signature[0]);
        if (mode == 0) return _validateProofMode(state, userOp, userOpHash);
        if (mode == 1) return _validateSessionMode(state, userOp, userOpHash);
        if (mode == 2) return _validateProposalMode(state, userOp);
        if (mode == 3) return _validateFinalizeMode(state, userOp, userOpHash);
        if (mode == 4) return _validateOwnerMode(state, userOp, userOpHash);
        return SIG_VALIDATION_FAILED;
    }

    function _validateProofMode(
        AccountState storage state,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal view returns (uint256) {
        if (state.permanentOwner != address(0)) {
            return SIG_VALIDATION_FAILED;
        }
        ProofAuth memory auth = abi.decode(userOp.signature[1:], (ProofAuth));
        if (
            auth.sessionKey == address(0)
                || auth.jwtIat > type(uint48).max - MAX_SESSION - CLOCK_SKEW
                || auth.sessionValidUntil <= auth.jwtIat
                || auth.sessionValidUntil
                    > uint48(auth.jwtIat) + MAX_SESSION + CLOCK_SKEW
                || !_isExactActivation(userOp.callData, auth)
        ) return SIG_VALIDATION_FAILED;
        bytes32 leaf =
            keccak256(bytes.concat(keccak256(abi.encode(auth.publicKeyHash))));
        if (!MerkleProof.verify(auth.jwkProof, googleJwkRoot, leaf)) {
            return SIG_VALIDATION_FAILED;
        }
        bytes32[] memory inputs = _publicInputs(
            state.accountId,
            auth.jwtIat,
            auth.publicKeyHash,
            sessionNonce(auth.sessionKey, auth.sessionValidUntil, auth.randomness)
        );
        bool proofOk;
        try googleProofVerifier.verify(auth.proof, inputs) returns (bool ok) {
            proofOk = ok;
        } catch {
            return SIG_VALIDATION_FAILED;
        }
        if (!proofOk || !_signedBy(auth.sessionKey, userOpHash, auth.sessionSignature)) return SIG_VALIDATION_FAILED;
        uint48 validAfter =
            auth.jwtIat > CLOCK_SKEW ? uint48(auth.jwtIat) - CLOCK_SKEW : 0;
        return _packValidationData(validAfter, uint48(auth.jwtIat) + PROOF_WINDOW);
    }

    function _validateSessionMode(
        AccountState storage state,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal view returns (uint256) {
        if (state.permanentOwner != address(0)) {
            return SIG_VALIDATION_FAILED;
        }
        if (
            state.sessionKey == address(0) || userOp.signature.length != 66
                || !_signedBy(state.sessionKey, userOpHash, userOp.signature[1:])
        ) return SIG_VALIDATION_FAILED;
        return _packValidationData(0, state.sessionValidUntil);
    }

    /// @notice Mode 0x02: valid self-passport proposal proof authorizes the
    /// exact `proposeRecovery(params, proposedOwner, recoveryNonce)` call only.
    /// No state change here; execution re-verifies the identical proof.
    function _validateProposalMode(
        AccountState storage state,
        PackedUserOperation calldata userOp
    ) internal view returns (uint256) {
        if (state.permanentOwner != address(0)) {
            return SIG_VALIDATION_FAILED;
        }
        PassportProposalAuth memory auth =
            abi.decode(userOp.signature[1:], (PassportProposalAuth));
        if (auth.proposedOwner == address(0) || auth.proposedOwner.code.length != 0) {
            return SIG_VALIDATION_FAILED;
        }
        if (auth.recoveryNonce != state.recoveryNonce + 1) {
            return SIG_VALIDATION_FAILED;
        }
        if (!_isExactProposal(userOp.callData, auth)) return SIG_VALIDATION_FAILED;
        bytes32 binding = _binding(
            ACTION_PROPOSE_RECOVERY,
            auth.proposedOwner,
            state.guardianNonce,
            auth.recoveryNonce
        );
        bytes32 nullifier;
        try this.verifyPassport(auth.params, msg.sender, binding) returns (
            bytes32 result
        ) {
            nullifier = result;
        } catch {
            return SIG_VALIDATION_FAILED;
        }
        if (nullifier != state.guardianNullifier) return SIG_VALIDATION_FAILED;
        return 0;
    }

    /// @notice Mode 0x03: the pending proposed local owner authorizes the exact
    /// `finalizeRecovery(recoveryNonce)` call only, at/after the deadline.
    function _validateFinalizeMode(
        AccountState storage state,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal view returns (uint256) {
        (uint64 recoveryNonce, bytes memory signature) =
            abi.decode(userOp.signature[1:], (uint64, bytes));
        RecoveryProposal memory proposal = state.recovery;
        if (proposal.proposedOwner == address(0) || proposal.nonce != recoveryNonce) {
            return SIG_VALIDATION_FAILED;
        }
        if (block.timestamp < proposal.executableAt) return SIG_VALIDATION_FAILED;
        if (!_isExactFinalize(userOp.callData, recoveryNonce)) {
            return SIG_VALIDATION_FAILED;
        }
        if (!_signedBy(proposal.proposedOwner, userOpHash, signature)) {
            return SIG_VALIDATION_FAILED;
        }
        return 0;
    }

    /// @notice Mode 0x04: the finalized permanent local owner signs normal
    /// Kernel operations.
    function _validateOwnerMode(
        AccountState storage state,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal view returns (uint256) {
        if (
            state.permanentOwner == address(0) || userOp.signature.length != 66
                || !_signedBy(state.permanentOwner, userOpHash, userOp.signature[1:])
        ) return SIG_VALIDATION_FAILED;
        return 0;
    }

    function _isExactActivation(bytes calldata callData, ProofAuth memory auth)
        internal
        view
        returns (bool)
    {
        bytes memory inner = abi.encodeCall(
            this.activateSession,
            (auth.sessionKey, auth.sessionValidUntil, auth.randomness)
        );
        bytes memory executionCalldata =
            abi.encodePacked(address(this), uint256(0), inner);
        bytes memory expected = abi.encodeWithSelector(
            KERNEL_EXECUTE_SELECTOR, bytes32(0), executionCalldata
        );
        return keccak256(callData) == keccak256(expected);
    }

    function _isExactProposal(bytes calldata callData, PassportProposalAuth memory auth)
        internal
        view
        returns (bool)
    {
        bytes memory inner = abi.encodeCall(
            this.proposeRecovery, (auth.params, auth.proposedOwner, auth.recoveryNonce)
        );
        bytes memory executionCalldata =
            abi.encodePacked(address(this), uint256(0), inner);
        bytes memory expected = abi.encodeWithSelector(
            KERNEL_EXECUTE_SELECTOR, bytes32(0), executionCalldata
        );
        return keccak256(callData) == keccak256(expected);
    }

    function _isExactFinalize(bytes calldata callData, uint64 recoveryNonce)
        internal
        view
        returns (bool)
    {
        bytes memory inner = abi.encodeCall(this.finalizeRecovery, (recoveryNonce));
        bytes memory executionCalldata =
            abi.encodePacked(address(this), uint256(0), inner);
        bytes memory expected = abi.encodeWithSelector(
            KERNEL_EXECUTE_SELECTOR, bytes32(0), executionCalldata
        );
        return keccak256(callData) == keccak256(expected);
    }

    function _publicInputs(
        bytes32 accountId_,
        uint64 jwtIat,
        bytes32 keyHash,
        bytes32 nonce
    ) internal pure returns (bytes32[] memory inputs) {
        inputs = new bytes32[](67);
        inputs[0] = accountId_;
        inputs[1] = bytes32(uint256(jwtIat));
        inputs[2] = keyHash;
        bytes16 symbols = "0123456789abcdef";
        for (uint256 i; i < 32; ++i) {
            uint8 value = uint8(nonce[i]);
            inputs[3 + 2 * i] = bytes32(uint256(uint8(symbols[value >> 4])));
            inputs[4 + 2 * i] = bytes32(uint256(uint8(symbols[value & 0x0f])));
        }
    }

    function _signedBy(address expected, bytes32 userOpHash, bytes memory signature)
        internal
        pure
        returns (bool)
    {
        if (signature.length != 65) return false;
        (address recovered, ECDSA.RecoverError error,) =
            ECDSA.tryRecover(userOpHash.toEthSignedMessageHash(), signature);
        return error == ECDSA.RecoverError.NoError && recovered == expected;
    }

    function _packValidationData(uint48 validAfter, uint48 validUntil)
        internal
        pure
        returns (uint256)
    {
        return (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }
}
