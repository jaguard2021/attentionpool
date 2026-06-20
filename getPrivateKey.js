const { ethers } = require('ethers');
const wallet = ethers.Wallet.createRandom();
console.log(`Alamat: ${wallet.address}`);
console.log(`Private Key: ${wallet.privateKey}`);