// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {
    IProofVerifier,
    PackedUserOperation,
    ZkLoginKernelValidator
} from "../src/ZkLoginKernelValidator.sol";

/// @dev Test-only verifier that validates the exact 67 public inputs produced
/// by the validator. It never verifies a real UltraPlonk proof.
contract StrictMockVerifier is IProofVerifier {
    bytes32 public expectedInputsHash;
    bool public result = true;
    bool public shouldRevert;

    function setExpectedInputs(bytes32[] calldata inputs) external {
        expectedInputsHash = keccak256(abi.encode(inputs));
    }

    function setResult(bool result_, bool shouldRevert_) external {
        result = result_;
        shouldRevert = shouldRevert_;
    }

    function verify(
        bytes calldata,
        bytes32[] calldata publicInputs
    ) external view returns (bool) {
        if (shouldRevert) revert("MOCK_VERIFIER_REVERT");
        return result && keccak256(abi.encode(publicInputs)) == expectedInputsHash;
    }
}

/// @dev Models the Kernel calling its installed root validator.
contract NodeKernelCaller {
    function install(
        ZkLoginKernelValidator validator,
        bytes32 accountId
    ) external {
        validator.onInstall(abi.encode(accountId));
    }

    function uninstall(ZkLoginKernelValidator validator) external {
        validator.onUninstall("");
    }

    function activate(
        ZkLoginKernelValidator validator,
        address sessionKey,
        uint48 validUntil,
        bytes32 randomness
    ) external {
        validator.activateSession(sessionKey, validUntil, randomness);
    }

    function validate(
        ZkLoginKernelValidator validator,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) external returns (uint256) {
        return validator.validateUserOp(userOp, userOpHash);
    }
}
