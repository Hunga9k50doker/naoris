const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const user_agents = require("./config/userAgents");
const settings = require("./config/config.js");
const { sleep, loadData, getRandomNumber, isTokenExpired, saveJson, loadJson } = require("./utils.js");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { checkBaseUrl } = require("./checkAPI");
const { headers } = require("./core/header.js");
const { showBanner } = require("./core/banner.js");

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL, tokens, localStorage) {
    this.headers = headers;
    this.baseURL = baseURL;
    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = tokens[this.session_name] || null;
    this.tokens = tokens;
    this.localStorage = localStorage;
    this.localItem = localStorage[this.session_name] || null;
    this.isExpiredToken = false;
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Tài khoản ${this.accountIndex + 1}] Tạo user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.itemData.address;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[NAORIS] [Account ${this.accountIndex + 1}][${this.itemData.address.slice(0, 6)}...][NODE_ID: ${this.itemData.deviceHash}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 1,
      isAuth: false,
      headers: {},
    }
  ) {
    const { retries, isAuth } = options;

    const headers = {
      ...this.headers,
      ...options.headers,
    };

    if (!isAuth) {
      headers["Authorization"] = `Bearer ${this.token}`;
      headers["Token"] = `Bearer ${this.token}`;
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    let currRetries = 0,
      success = false;
    do {
      try {
        const response = await axios({
          method,
          url: `${url}`,
          data,
          headers,
          timeout: 30000,
          ...(proxyAgent ? { httpsAgent: proxyAgent } : {}),
        });
        success = true;
        if (response?.data?.data) return { status: response.data.statusCode, success: true, data: response.data.data };
        return { success: true, data: response.data, status: response.status };
      } catch (error) {
        const errMesss = error.response.data.message || error.response.data.error || error.message;
        if (error.status == 429) {
          this.log(`Many requests failed 429 | Waiting 60s...`, "warning");
          await sleep(60);
        }
        if (error.status == 401) {
          const token = await this.getValidToken(true);
          if (!token) {
            process.exit(1);
          }
          this.token = token;
          return this.makeRequest(url, method, data, options);
        }
        if (error.status == 400) {
          this.log(`Invalid request for ${url}, maybe have new update from server | contact: https://t.me/airdrophuntersieutoc to get new update!`, "error");
          return { success: false, status: error.status, error: errMesss };
        }

        if (error.status == 410 && url.includes("/api/ping")) {
          return { success: true, status: error.status, data: errMesss };
        }
        if (error.status >= 400 && error.status < 500) {
          return { success: true, status: error.status, data: errMesss };
        }
        this.log(`Request failed: ${url} | ${errMesss} | retrying...`, "warning");
        success = false;
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
        if (currRetries == retries) return { status: error.status, success: false, error: errMesss };
      }
      currRetries++;
    } while (currRetries <= retries && !success);
  }

  async auth() {
    return this.makeRequest(`${this.baseURL}/auth/generateToken`, "post", { wallet_address: this.itemData.address }, { isAuth: true });
  }

  async getUserData() {
    return this.makeRequest(`https://naorisprotocol.network/testnet-api/api/testnet/walletDetails`, "post", { walletAddress: this.itemData.address });
  }

  async getBalance() {
    return this.makeRequest(`${this.baseURL}/api/wallet-details`, "get");
  }

  async htbEvent() {
    return this.makeRequest(`${this.baseURL}/api/htb-event`, "post", {
      inputData: {
        walletAddress: this.itemData.address,
        deviceHash: this.itemData.deviceHash,
      },
    });
  }

  async activeNodes() {
    return this.makeRequest(`https://naorisprotocol.network/ext-api/api/active-nodes`, "get");
  }

  async addWhitelist() {
    return this.makeRequest(`${this.baseURL}/api/addWhitelist`, "post", { walletAddress: this.itemData.address, url: "naorisprotocol.network" });
  }

  async toggleActivate(state) {
    return this.makeRequest(`${this.baseURL}/api/toggle`, "post", { walletAddress: this.itemData.address, state: state, deviceHash: this.itemData.deviceHash });
  }

  async ping() {
    return this.makeRequest(
      `https://beat.naorisprotocol.network/api/ping`,
      "post",
      {},
      {
        headers: {
          Origin: "chrome-extension://cpikalnagknmlfhnilhfelifgbollmmp",
        },
      }
    );
  }

  async getWhiteList() {
    return this.makeRequest(`https://naorisprotocol.network/ext-api/api/getWhitelist`, "post", {
      walletAddress: this.itemData.address,
    });
  }

  async getTasks() {
    return this.makeRequest(`${this.baseURL}/tasks`, "get");
  }

  async getValidToken(isNew = false) {
    const existingToken = this.token;
    const { expirationDate, isExpired } = isTokenExpired(existingToken);
    existingToken && this.log(`Token status: ${isExpired ? "Expired".yellow : "Valid".green} | Token expires: ${expirationDate}`);
    if (existingToken && !isNew && !isExpired) {
      this.log("Using valid token", "success");
      return existingToken;
    } else {
      this.isExpiredToken = true;
      this.log("No found token or experied, trying get new token...", "warning");
      const newToken = await this.auth();
      const token = newToken.data?.token;
      if (newToken.success && token) {
        this.log("Get new token success!", "success");
        saveJson(this.session_name, token, "tokens.json");
        return token;
      }
      this.log(`Can't get new token | ${JSON.stringify(newToken)}...`, "warning");
      return null;
    }
  }

  handleDataLocal(data = {}, isUpdate = false) {
    // const rpm = Math.max(this.localItem?.activeRatePerMinute || 0, data?.activeRatePerMinute || 0, 0.005);
    // const totalEarnings = Math.max(this.localItem?.totalEarnings || 0, data?.totalEarnings || 0, 0);
    // const todayEarnings = Math.max(this.localItem?.todayEarnings || 0, data?.todayEarnings || 0, 0);
    // const totalUptimeMinutes = Math.max(this.localItem?.totalUptimeMinutes || 0, data?.totalUptimeMinutes || 0, 0);
    const rpm = Math.max(data?.activeRatePerMinute || 0, 0.005);
    const totalEarnings = Math.max(data?.totalEarnings || 0, 0);
    const todayEarnings = Math.max(data?.todayEarnings || 0, 0);
    const totalUptimeMinutes = Math.max(data?.totalUptimeMinutes || 0, 0);
    const newTotalEarnings = !isUpdate ? totalEarnings : totalEarnings + rpm * settings.TIME_SLEEP;
    const newTodayEarnings = !isUpdate ? todayEarnings : todayEarnings + rpm * settings.TIME_SLEEP;
    const newTotalUptimeMinutes = !isUpdate ? totalUptimeMinutes : totalUptimeMinutes + settings.TIME_SLEEP;

    return {
      newTotalEarnings: +newTotalEarnings.toFixed(4),
      newTodayEarnings: +newTodayEarnings.toFixed(4),
      newTotalUptimeMinutes: +newTotalUptimeMinutes.toFixed(4),
      rpm,
    };
  }

  async handlePing() {
    const pingRes = await this.ping();
    const htbRes = await this.htbEvent();
    this.log(JSON.stringify(htbRes));
    if (pingRes.success) {
      this.log("Ping success!", "success");
      // const { newTotalEarnings, newTodayEarnings, newTotalUptimeMinutes, rpm } = this.handleDataLocal(this.localItem, true);
      // const value = {
      //   ...(this.localItem || {}),
      //   lastPing: new Date().toISOString(),
      //   totalEarnings: newTotalEarnings,
      //   todayEarnings: newTodayEarnings,
      //   activeRatePerMinute: rpm,
      //   totalUptimeMinutes: newTotalUptimeMinutes,
      // };
      // saveJson(`${this.session_name}_${this.itemData.deviceHash}`, value, "localStorage.json");
    } else {
      this.log(`Can't ping | ${JSON.stringify(pingRes || {})}`, "warning");
    }
  }

  async handleStart() {
    const isEnable = this.localItem?.isActive || false;
    if (!isEnable || this.isExpiredToken) {
      const resToggle = await this.toggleActivate("ON");
      if (resToggle.success) {
        this.log(`Active node sucess | ${JSON.stringify(resToggle)}`, "success");
      }
      this.localItem = {
        ...(this.localItem || {}),
        isActive: true,
        address: this.session_name,
        deviceHash: this.itemData.deviceHash,
      };
      parentPort.postMessage({ message: "updateLocalStorage", key: `${this.session_name}_${this.itemData.deviceHash}`, value: this.localItem });
    }
  }

  async handleWhitelist() {
    let isWL = this.localItem?.isWhiteList;
    if (isWL) return;
    const resultGet = await this.getWhiteList();
    if (resultGet.success) {
      isWL = resultGet.data.whitelist.find((i) => i === "naorisprotocol.network");
      if (!isWL) {
        const result = await this.addWhitelist();
        this.log(`Added whitelist | ${JSON.stringify(result)}`, "success");
      }
      this.localItem = {
        ...(this.localItem || {}),
        isWhiteList: true,
      };
      parentPort.postMessage({ message: "updateLocalStorage", key: `${this.session_name}_${this.itemData.deviceHash}`, value: this.localItem });
    }
  }

  async handleSyncData() {
    let userData = { success: false, data: null },
      retries = 0;
    do {
      userData = await this.getUserData();
      if (userData?.success) break;
      retries++;
    } while (retries < 2);

    const balanceRes = await this.getBalance();
    if (userData.success && userData.data?.details) {
      const { totalEarnings: newTotal } = balanceRes.data.message;
      const { totalEarnings, todayEarnings, activeRatePerMinute, totalUptimeMinutes } = userData.data.details;
      const points = Math.max(totalEarnings, newTotal, 0);
      const { newTotalEarnings, newTodayEarnings, newTotalUptimeMinutes, rpm } = this.handleDataLocal(
        {
          totalEarnings: points,
          todayEarnings,
          activeRatePerMinute,
          totalUptimeMinutes,
        },
        false
      );

      this.log(
        `Total Nodes ${this.itemData.totalNodes} | Earning today: ${newTodayEarnings} | Total points: ${newTotalEarnings} | RPM(points/minutes): ${rpm} p/m | Uptimes: ${newTotalUptimeMinutes} minutes`,
        "custom"
      );
      this.localItem = {
        ...(this.localItem || {}),
        totalEarnings: newTotalEarnings,
        todayEarnings: newTodayEarnings,
        activeRatePerMinute: rpm,
        totalUptimeMinutes: newTotalUptimeMinutes,
      };
      parentPort.postMessage({ message: "updateLocalStorage", key: `${this.session_name}_${this.itemData.deviceHash}`, value: this.localItem });
    } else {
      return this.log("Can't sync new data...skipping", "warning");
    }
    return userData;
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = this.itemData.address;
    this.token = this.tokens[this.session_name];
    this.localItem = this.localStorage[`${this.session_name}_${this.itemData.deviceHash}`];
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }

    const token = await this.getValidToken();
    if (!token) return;
    this.token = token;
    const userData = await this.handleSyncData();
    if (userData.success) {
      await this.handleWhitelist();
      await sleep(1);
      await this.handleStart();
      await sleep(1);
      await this.handlePing();
      await sleep(1);
      // await this.handleSyncData();
    } else {
      return this.log("Can't get use info...skipping", "error");
    }
  }
}

async function runWorker(workerData) {
  const { itemData, accountIndex, proxy, hasIDAPI, tokens, localStorage } = workerData;
  const to = new ClientAPI(itemData, accountIndex, proxy, hasIDAPI, tokens, localStorage);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  showBanner();
  // fs.writeFile("./tokens.json", JSON.stringify({}), (err) => {});
  // await sleep(1);
  let data = await loadJson("accounts.json", []);
  const proxies = loadData("proxy.txt");
  let tokens = await loadJson("tokens.json");
  const itemDatas = [];
  // let accounts = require("./accounts.json");
  const totalDeviceHashes = data.reduce((total, item) => total + Math.max(item.deviceHash.length, settings.NODE_PER_ACCOUNT), 0);
  console.log(`Total node: ${totalDeviceHashes} | Proxy: ${proxies.length}`);
  if (data.length == 0 || (totalDeviceHashes > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy ít nhất phải bằng tổng số node.".red);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const { endpoint, message } = await checkBaseUrl();
  if (!endpoint) return console.log(`Không thể tìm thấy ID API, thử lại sau!`.red);
  console.log(`${message}`.yellow);

  data.map((val, i) => {
    const address = val.walletAddress;
    const deviceHashes = val.deviceHash;
    for (const id of deviceHashes) {
      itemDatas.push({
        address: address,
        deviceHash: +id,
        totalNodes: deviceHashes.length,
      });
    }
    const item = { address, totalNodes: deviceHashes.length, deviceHash: +deviceHashes[0], deviceHashes, lastPingTimestamp: 0 };
    new ClientAPI(item, i, proxies[i], endpoint, tokens, {}).createUserAgent();
    return item;
  });
  data = itemDatas;
  while (true) {
    const newTokens = await loadJson("tokens.json");
    const localStorage = await loadJson("localStorage.json");
    let newLocalStorage = localStorage;
    await sleep(1);

    let currentIndex = 0;
    const errors = [];
    while (currentIndex < data.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, data.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI: endpoint,
            itemData: itemDatas[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex],
            tokens: newTokens,
            localStorage,
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (message?.message === "updateLocalStorage") {
                const key = message.key;
                newLocalStorage[key] = message.value;
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < data.length) {
        await sleep(5);
      }
    }
    await fs.writeFileSync("localStorage.json", JSON.stringify(newLocalStorage, null, 4));
    await sleep(10);
    console.log(`=============${new Date().toLocaleString()} | Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    showBanner();
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
