// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;
import {Script} from "forge-std/Script.sol";
import {
    IProofVerifier,
    ZkLoginKernelValidator
} from "../src/ZkLoginKernelValidator.sol";

contract Deploy is Script {
    function run() external returns (ZkLoginKernelValidator validator) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envAddress("ULTRA_VERIFIER_ADDRESS");
        bytes32 jwkRoot = vm.envBytes32("GOOGLE_JWK_ROOT");
        bytes32 appId = vm.envBytes32("APP_ID");
        vm.startBroadcast(deployerKey);
        validator = new ZkLoginKernelValidator(IProofVerifier(verifier), jwkRoot, appId);
        vm.stopBroadcast();
    }
}
