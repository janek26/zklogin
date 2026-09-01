// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {VerifierHelper} from "@zkpassport/registry-contracts/VerifierHelper.sol";
import {
    BoundData,
    FaceMatchMode,
    OS,
    ProofVerificationParams
} from "@zkpassport/registry-contracts/lib/Types.sol";
import {
    IProofVerifier,
    PackedUserOperation,
    ZkLoginKernelValidatorV2
} from "../src/ZkLoginKernelValidatorV2.sol";

/// @dev Test-only ZKPassport helper. Standalone contract with the same
/// external selectors as VerifierHelper; V2 calls it through the returned
/// VerifierHelper address. Every check is independently flippable.
contract MockVerifierHelper {
    bool public scopesOk = true;
    bool public faceMatchOk = true;
    address public senderValue;
    uint256 public chainValue;
    string public customDataValue;

    function setScopesOk(bool value) external {
        scopesOk = value;
    }

    function setFaceMatchOk(bool value) external {
        faceMatchOk = value;
    }

    function setBoundData(address sender, uint256 chainId, string calldata customData)
        external
    {
        senderValue = sender;
        chainValue = chainId;
        customDataValue = customData;
    }

    function verifyScopes(bytes32[] calldata, string calldata, string calldata)
        external
        view
        returns (bool)
    {
        return scopesOk;
    }

    function isFaceMatchVerified(FaceMatchMode, OS, bytes calldata)
        external
        view
        returns (bool)
    {
        return faceMatchOk;
    }

    function getBoundData(bytes calldata) external view returns (BoundData memory) {
        return BoundData({
            senderAddress: senderValue, chainId: chainValue, customData: customDataValue
        });
    }
}

/// @dev Test-only ZKPassport root verifier. Returns the configured validity,
/// uniqueIdentifier, and helper; every rejection path is a flippable flag.
contract MockRootVerifier {
    bool public valid = true;
    bytes32 public uniqueIdentifier;
    MockVerifierHelper public helper;

    function setValid(bool value) external {
        valid = value;
    }

    function setUniqueIdentifier(bytes32 value) external {
        uniqueIdentifier = value;
    }

    function setHelper(MockVerifierHelper helper_) external {
        helper = helper_;
    }

    function verify(ProofVerificationParams calldata)
        external
        view
        returns (bool valid_, bytes32 uniqueIdentifier_, VerifierHelper helper_)
    {
        return (valid, uniqueIdentifier, VerifierHelper(address(helper)));
    }
}

/// @dev Builds committedInputs for MockVerifierHelper.getBoundData. The
/// contract passes these bytes straight to getBoundData, so the payload only
/// needs to round-trip through the mock.
library MockPassportInputs {
    function encodeCommittedInputs(
        address sender,
        uint256 chainId,
        string memory customData
    ) internal pure returns (bytes memory) {
        return abi.encode(sender, chainId, customData);
    }

    function makeParams(
        address sender,
        uint256 chainId,
        string memory customData,
        bool devMode,
        uint256 validity,
        string memory domain,
        string memory scope
    ) internal pure returns (ProofVerificationParams memory) {
        bytes32[] memory publicInputs = new bytes32[](7);
        ProofVerificationParams memory params;
        params.version = bytes32(uint256(1));
        params.proofVerificationData.vkeyHash = bytes32(uint256(2));
        params.proofVerificationData.proof = hex"deadbeef";
        params.proofVerificationData.publicInputs = publicInputs;
        params.committedInputs = encodeCommittedInputs(sender, chainId, customData);
        params.serviceConfig.validityPeriodInSeconds = validity;
        params.serviceConfig.domain = domain;
        params.serviceConfig.scope = scope;
        params.serviceConfig.devMode = devMode;
        return params;
    }
}

/// @dev Models the Kernel calling its installed root validator.
contract NodeKernelCallerV2 {
    function install(ZkLoginKernelValidatorV2 validator, bytes32 accountId) external {
        validator.onInstall(abi.encode(accountId));
    }

    function uninstall(ZkLoginKernelValidatorV2 validator) external {
        validator.onUninstall("");
    }

    function activate(
        ZkLoginKernelValidatorV2 validator,
        address sessionKey,
        uint48 validUntil,
        bytes32 randomness
    ) external {
        validator.activateSession(sessionKey, validUntil, randomness);
    }

    function setGuardian(
        ZkLoginKernelValidatorV2 validator,
        ProofVerificationParams calldata params,
        uint48 delay
    ) external {
        validator.setGuardian(params, delay);
    }

    function clearGuardian(ZkLoginKernelValidatorV2 validator) external {
        validator.clearGuardian();
    }

    function cancelRecovery(ZkLoginKernelValidatorV2 validator) external {
        validator.cancelRecovery();
    }

    function proposeRecovery(
        ZkLoginKernelValidatorV2 validator,
        ProofVerificationParams calldata params,
        address proposedOwner,
        uint64 recoveryNonce
    ) external {
        validator.proposeRecovery(params, proposedOwner, recoveryNonce);
    }

    function finalizeRecovery(ZkLoginKernelValidatorV2 validator, uint64 recoveryNonce)
        external
    {
        validator.finalizeRecovery(recoveryNonce);
    }

    function validate(
        ZkLoginKernelValidatorV2 validator,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) external returns (uint256) {
        return validator.validateUserOp(userOp, userOpHash);
    }
}

/// @dev Strict Google-verifier mock shared with the V1 helper contract, so the
/// V2 Google/session modes are exercised with the same test fixture.
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

    function verify(bytes calldata, bytes32[] calldata publicInputs)
        external
        view
        returns (bool)
    {
        if (shouldRevert) revert("MOCK_VERIFIER_REVERT");
        return result && keccak256(abi.encode(publicInputs)) == expectedInputsHash;
    }
}
