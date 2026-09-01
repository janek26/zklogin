// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {UltraVerifier} from "../src/UltraVerifier.sol";

/// @dev Locks the restored UltraVerifier (pre-forge-fmt source, 11,053-byte
/// runtime) against behavioral regressions: verification-key identity and
/// strict rejection of malformed proofs. The verifier reverts with custom
/// errors on invalid input instead of returning false. Runs under the
/// deployment compile settings (no via-ir, optimizer 200) — the same artifact
/// we deploy.
contract UltraVerifierTest is Test {
    UltraVerifier internal verifier;

    bytes32 internal constant EXPECTED_VK_HASH =
        0xdf17b68894fbe76ada8e2859abb6925eb52b99f2516db87bc9720ed3f22c9625;

    function setUp() public {
        verifier = new UltraVerifier();
    }

    function test_verificationKeyHashIsPinned() public view {
        assertEq(verifier.getVerificationKeyHash(), EXPECTED_VK_HASH);
    }

    function test_rejectsEmptyProof() public {
        bytes32[] memory inputs = new bytes32[](67);
        vm.expectRevert();
        verifier.verify("", inputs);
    }

    function test_rejectsWrongInputCount() public {
        bytes32[] memory inputs = new bytes32[](66);
        vm.expectRevert();
        verifier.verify(hex"deadbeef", inputs);
    }

    function test_rejectsGarbageProofWithRightInputCount() public {
        bytes32[] memory inputs = new bytes32[](67);
        vm.expectRevert();
        verifier.verify(hex"deadbeef", inputs);
    }

    function test_rejectsProofTooShort() public {
        bytes32[] memory inputs = new bytes32[](67);
        vm.expectRevert();
        verifier.verify(hex"00", inputs);
    }
}
