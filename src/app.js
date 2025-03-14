require("dotenv").config();
const fs = require('fs')
const { CloudClient,FileTokenStore } = require("cloud189-sdk");
const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
const families = require("../families");
const {
  mask,
  delay,
} = require("./utils");
const push = require("./push");
const { log4js, cleanLogs, catLogs } = require("./logger");
const execThreshold = process.env.EXEC_THRESHOLD || 1;
const cacheToken =  process.env.CACHE_TOKEN === "1";
const mainAccount = process.env.MAIN_ACCOUNT || 1; //主账号个数
const tokenDir = ".token"

// 个人任务签到
const doUserTask = async (cloudClient, logger, index) => {
	if(index < mainAccount){
		const tasks = Array.from({ length: 1 }, () =>
			cloudClient.userSign()
		);
		const result = (await Promise.all(tasks)).filter((res) => !res.isSign);
		logger.info(
			`${result.length}/${tasks.length} 个人获得(M): ${
			result.map((res) => res.netdiskBonus)?.join(" ") || "0"
			}`
		);
		await delay(2000); // 延迟2秒
	}
};

// 家庭任务签到
const doFamilyTask = async (cloudClient, logger, index) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  if (familyInfoResp) {
    let familyId = null;
    //指定家庭签到
    if (families.length > 0) {
      const tagetFamily = familyInfoResp.find((familyInfo) =>
        families.includes(familyInfo.remarkName)
      );
      if (tagetFamily) {
        familyId = tagetFamily.familyId;
      } else {
        return logger.error(
          `没有加入到指定家庭分组`
        );
      }
    } else {
      familyId = familyInfoResp[0].familyId;
    }
    
	const tasks = Array.from({ length: index < mainAccount ? 1 : execThreshold }, () =>
		cloudClient.familyUserSign(familyId)
	);

   const results = await Promise.allSettled(tasks);
   const validResults = results
				.filter(r => r.status === 'fulfilled') // 只保留成功的任务
				.map(r => r.value) //提取成功的任务结果
				.filter(Boolean) // 过滤内部捕获的null
				.filter(res => 'signStatus' in res && !res.signStatus); // 安全属性检查
    return logger.info(
      ` ${validResults.length}/${tasks.length} 家庭获得(M): ${
        validResults.map((res) => res.bonusSpace)?.join(" ") || "0"
      }`
    );
  }
};

const run = async (userName, password, userSizeInfoMap, logger, index) => {
  if (userName && password) {
    const before = Date.now();
	const userNameInfo = mask(userName, 3, 7);
    try {
      logger.log(`${index+1}. 账号${userNameInfo}`);
      let token = null
      if(cacheToken) {
        token = new FileTokenStore(`${tokenDir}/${userName}.json`)
      }
      const cloudClient = new CloudClient({
        username: userName, 
        password,
        token: token
      });
      const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();
      userSizeInfoMap.set(userName, {
        cloudClient,
        userSizeInfo: beforeUserSizeInfo,
        logger,
      });
      
        await doUserTask(cloudClient, logger, index);
        await doFamilyTask(cloudClient, logger, index);
    
    } catch (e) {
      if (e.response) {
        logger.log(`请求失败: ${e.response.statusCode}, ${e.response.body}`);
      } else {
        logger.error(e);
      }
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.error("请求超时");
        throw e;
      }
    } finally {
      logger.log(
        `耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`
      );
	  logger.log(' ');
	 await delay((Math.random() * 3000) + 5000); // 随机等待5到8秒
    }
  }
};

// 开始执行程序
async function main() {
	let mainAccountCount  = 0 ; //主账号详情循环
	
  if(cacheToken && !fs.existsSync(tokenDir)){
    fs.mkdirSync(tokenDir)
  }
  //  用于统计实际容量变化
  const userSizeInfoMap = new Map();
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password } = account;
	const logger = log4js.getLogger(userName);
	 logger.addContext("user", "" ); 
    await run(userName, password, userSizeInfoMap, logger, index);
	 
  }

  //主账号详情
  for (const [userName, { cloudClient, userSizeInfo, logger } ] of userSizeInfoMap) {
	   if(mainAccountCount < mainAccount){
		   const userNameInfo = mask(userName, 3, 7);
			const afterUserSizeInfo = await cloudClient.getUserSizeInfo();
			logger.log(`账号 ${userNameInfo}:`);
			logger.log(`前 个人：${ (
				(userSizeInfo.cloudCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G, 家庭：${(
				( userSizeInfo.familyCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G`);
			logger.log(`后 个人：${(
				(afterUserSizeInfo.cloudCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G, 家庭：${(
				(afterUserSizeInfo.familyCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G`);
			logger.log(
			`个人总容量增加：${(
			(afterUserSizeInfo.cloudCapacityInfo.totalSize -
			userSizeInfo.cloudCapacityInfo.totalSize) /
			1024 /
			1024
			).toFixed(0)}M,家庭容量增加：${(
			(afterUserSizeInfo.familyCapacityInfo.totalSize -
			userSizeInfo.familyCapacityInfo.totalSize) /
			1024 /
			1024
			).toFixed(0)}M`
			);
			logger.log(' ');
			mainAccountCount++;
		}else{
			break;
		}
  }
}

function getLineIndex(str, lineIndex) {
  // 参数校验
  if (typeof str !== 'string' || !Number.isInteger(lineIndex)) {
    return '';
  }

  // 单次分割处理（兼容不同系统换行符）
  const lines = str.split(/\r?\n/);
  
  // 处理边界情况
  return lineIndex >= 0 && lineIndex < lines.length 
    ? String(lines[lineIndex]).trim() // 移除前后空格
    : '';
}


(async () => {
  try {
    await main();
    //等待日志文件写入
    await delay(1000);
  } finally {
    const logs = catLogs();
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
	const lineCount = logs.split('\n').length;
    push(` ${getLineIndex(logs,lineCount - 6).slice(10, 14)}天翼${getLineIndex(logs, lineCount - 3).slice(-9)}`, logs + content);
    recording.erase();
    cleanLogs();
  }
})();
