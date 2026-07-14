// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {
    IProofVerifier,
    PackedUserOperation,
    ZkLoginKernelValidator
} from "../src/ZkLoginKernelValidator.sol";

contract MockVerifier is IProofVerifier {
    bool internal result = true;
    bool internal shouldRevert;

    function setResult(bool value, bool reverts_) external {
        result = value;
        shouldRevert = reverts_;
    }

    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        if (shouldRevert) revert("mock");
        return result;
    }
}

contract KernelCaller {
    function install(ZkLoginKernelValidator validator, bytes32 accountId) external {
        validator.onInstall(abi.encode(accountId));
    }

    function uninstall(ZkLoginKernelValidator validator) external {
        validator.onUninstall("");
    }

    function activate(
        ZkLoginKernelValidator validator,
        address key,
        uint48 until,
        bytes32 randomness
    ) external {
        validator.activateSession(key, until, randomness);
    }

    function validate(
        ZkLoginKernelValidator validator,
        PackedUserOperation calldata op,
        bytes32 hash
    ) external returns (uint256) {
        return validator.validateUserOp(op, hash);
    }
}

contract ZkLoginKernelValidatorTest is Test {
    MockVerifier internal verifier;
    ZkLoginKernelValidator internal validator;
    KernelCaller internal kernel;
    uint256 internal key = 0xA11CE;
    address internal sessionKey;
    bytes32 internal accountId = keccak256("account");
    bytes32 internal publicKeyHash = keccak256("jwk");
    bytes32 internal randomness = keccak256("randomness");
    uint64 internal jwtIat;
    uint48 internal validUntil;

    function setUp() public {
        vm.warp(1_700_000_000);
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(publicKeyHash))));
        verifier = new MockVerifier();
        validator = new ZkLoginKernelValidator(verifier, leaf, keccak256("app"));
        kernel = new KernelCaller();
        kernel.install(validator, accountId);
        sessionKey = vm.addr(key);
        jwtIat = uint64(block.timestamp);
        validUntil = uint48(block.timestamp + 1 hours);
    }

    function _activation() internal view returns (bytes memory) {
        bytes memory inner = abi.encodeCall(
            validator.activateSession, (sessionKey, validUntil, randomness)
        );
        return abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            bytes32(0),
            abi.encodePacked(address(validator), uint256(0), inner)
        );
    }

    function _proofOp(bytes memory callData, bytes memory sessionSig)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        ZkLoginKernelValidator.ProofAuth memory auth =
            ZkLoginKernelValidator.ProofAuth({
                proof: hex"0102",
                jwtIat: jwtIat,
                publicKeyHash: publicKeyHash,
                jwkProof: new bytes32[](0),
                sessionKey: sessionKey,
                sessionValidUntil: validUntil,
                randomness: randomness,
                sessionSignature: sessionSig
            });
        op.sender = address(kernel);
        op.callData = callData;
        op.signature = bytes.concat(hex"00", abi.encode(auth));
    }

    function _signatureFor(bytes memory callData) internal returns (bytes memory) {
        PackedUserOperation memory unsigned = _proofOp(callData, hex"");
        bytes32 hash = keccak256(abi.encode(unsigned.sender, unsigned.callData));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash))
        );
        return abi.encodePacked(r, s, v);
    }

    function testInstallAndUninstall() public {
        assertTrue(validator.isInitialized(address(kernel)));
        kernel.uninstall(validator);
        assertFalse(validator.isInitialized(address(kernel)));
    }

    function testProofModeAcceptsExactActivationAndBoundKeySignature() public {
        bytes memory callData = _activation();
        PackedUserOperation memory op = _proofOp(callData, _signatureFor(callData));
        bytes32 hash = keccak256(abi.encode(op.sender, op.callData));
        assertEq(
            kernel.validate(validator, op, hash),
            (uint256(uint48(jwtIat) - validator.CLOCK_SKEW()) << 208)
                | (uint256(uint48(jwtIat) + validator.PROOF_WINDOW()) << 160)
        );
    }

    function testProofModeRejectsFalseAndRevertingVerifier() public {
        bytes memory callData = _activation();
        PackedUserOperation memory op = _proofOp(callData, _signatureFor(callData));
        bytes32 hash = keccak256(abi.encode(op.sender, op.callData));
        verifier.setResult(false, false);
        assertEq(kernel.validate(validator, op, hash), 1);
        verifier.setResult(true, true);
        assertEq(kernel.validate(validator, op, hash), 1);
    }

    function testProofModeRejectsChangedUserOperationHash() public {
        bytes memory callData = _activation();
        PackedUserOperation memory op = _proofOp(callData, _signatureFor(callData));
        assertEq(kernel.validate(validator, op, keccak256("changed")), 1);
    }

    function testProofRejectsWrongActivationTarget() public {
        bytes memory altered = abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            bytes32(0),
            abi.encodePacked(address(0xBEEF), uint256(0), hex"")
        );
        PackedUserOperation memory op = _proofOp(altered, _signatureFor(altered));
        assertEq(
            kernel.validate(
                validator, op, keccak256(abi.encode(op.sender, op.callData))
            ),
            1
        );
    }

    function testSessionModeAcceptsArbitraryCallDataAfterActivation() public {
        kernel.activate(validator, sessionKey, validUntil, randomness);
        bytes32 hash = keccak256("userop");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash))
        );
        PackedUserOperation memory op;
        op.sender = address(kernel);
        op.callData = hex"deadbeef";
        op.signature = bytes.concat(hex"01", abi.encodePacked(r, s, v));
        assertEq(kernel.validate(validator, op, hash), uint256(validUntil) << 160);
    }

    function testERC1271IsAlwaysInvalid() public {
        assertEq(
            validator.isValidSignatureWithSender(address(kernel), bytes32(0), ""),
            bytes4(0xffffffff)
        );
    }
}
