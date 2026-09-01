// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {Script} from "forge-std/Script.sol";
import {RootVerifier} from "@zkpassport/registry-contracts/RootVerifier.sol";
import {
    IProofVerifier,
    ZkLoginKernelValidatorV2
} from "../src/ZkLoginKernelValidatorV2.sol";

/// @notice Sepolia V2 deployment. Constructor inputs come from env so the
/// ZKPassport verifier address and Google verifier/root/app-id are never
/// baked into source.
contract DeployV2 is Script {
    function run() external returns (ZkLoginKernelValidatorV2 validator) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envAddress("ULTRA_VERIFIER_ADDRESS");
        bytes32 jwkRoot = vm.envBytes32("GOOGLE_JWK_ROOT");
        bytes32 appId = vm.envBytes32("APP_ID");
        address zkPassportVerifier = vm.envAddress("ZKPASSPORT_VERIFIER_ADDRESS");
        vm.startBroadcast(deployerKey);
        validator = new ZkLoginKernelValidatorV2(
            IProofVerifier(verifier), jwkRoot, appId, RootVerifier(zkPassportVerifier)
        );
        vm.stopBroadcast();
    }
}
