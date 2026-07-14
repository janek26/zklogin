// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {
    MessageHashUtils
} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

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

contract ZkLoginKernelValidator is IValidator {
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
    IProofVerifier public immutable proofVerifier;
    bytes32 public immutable googleJwkRoot;
    bytes32 public immutable appId;

    struct AccountState {
        bytes32 accountId;
        address sessionKey;
        uint48 sessionValidUntil;
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
    mapping(address kernel => AccountState) public accountState;
    event AccountInstalled(address indexed kernel, bytes32 indexed accountId);
    event SessionActivated(
        address indexed kernel, address indexed sessionKey, uint48 validUntil
    );

    constructor(IProofVerifier proofVerifier_, bytes32 googleJwkRoot_, bytes32 appId_) {
        require(address(proofVerifier_) != address(0), "ZERO_VERIFIER");
        require(googleJwkRoot_ != bytes32(0), "ZERO_JWK_ROOT");
        require(appId_ != bytes32(0), "ZERO_APP_ID");
        proofVerifier = proofVerifier_;
        googleJwkRoot = googleJwkRoot_;
        appId = appId_;
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
        require(sessionKey != address(0), "ZERO_SESSION_KEY");
        require(validUntil >= block.timestamp, "SESSION_ALREADY_EXPIRED");
        state.sessionKey = sessionKey;
        state.sessionValidUntil = validUntil;
        emit SessionActivated(msg.sender, sessionKey, validUntil);
    }

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
        return SIG_VALIDATION_FAILED;
    }

    function _validateProofMode(
        AccountState storage state,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal returns (uint256) {
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
        try proofVerifier.verify(auth.proof, inputs) returns (bool ok) {
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
        if (
            state.sessionKey == address(0) || userOp.signature.length != 66
                || !_signedBy(state.sessionKey, userOpHash, userOp.signature[1:])
        ) return SIG_VALIDATION_FAILED;
        return _packValidationData(0, state.sessionValidUntil);
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
