const fs = require("fs");
const settings = require("./config/config.js");
const { loadData, generateComplexId } = require("./utils.js");
const { showBanner } = require("./core/banner.js");

async function main() {
  showBanner();
  const data = loadData("wallets.txt");
  let accounts = require("./accounts.json");
  const newAccounts = accounts;
  if (data.length == 0) return console.log("No wallet in wallets.txt");
  for (let i = 0; i < data.length; i++) {
    console.log(`Create device hash for ${data[i]}...`);
    const accIndex = accounts.findIndex((account) => account.walletAddress === data[i]);
    if (accIndex >= 0 && accounts[accIndex]?.deviceHash) {
      const numToCreate = settings.NODE_PER_ACCOUNT - Math.min(settings.NODE_PER_ACCOUNT, accounts[accIndex].deviceHash.length);
      for (let j = 0; j < numToCreate; j++) {
        const deviceHash = generateComplexId(9);
        newAccounts[accIndex].deviceHash.push(deviceHash);
        fs.writeFileSync("accounts.json", JSON.stringify(newAccounts, null, 2));
      }
    } else {
      let nodes = [];
      for (let j = 0; j < settings.NODE_PER_ACCOUNT; j++) {
        nodes.push(generateComplexId(9));
      }
      newAccounts.push({ walletAddress: data[i], deviceHash: nodes });
      fs.writeFileSync("accounts.json", JSON.stringify(newAccounts, null, 2));
    }
  }
  console.log(`Finish creating device hashes ${settings.NODE_PER_ACCOUNT} each wallet`.green);
}

main();
