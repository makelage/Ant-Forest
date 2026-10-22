/*
 * @Author: TonyJiangWJ
 * @Date: 2020-09-07 13:06:32
 * @Last Modified by: TonyJiangWJ
 * @Last Modified time: 2025-08-31 17:36:18
 * @Description: 逛一逛收集器
 */
let { config: _config, storage_name: _storage_name } = require('../config.js')(runtime, global)
let singletonRequire = require('../lib/SingletonRequirer.js')(runtime, global)
let _widgetUtils = singletonRequire('WidgetUtils')
let automator = singletonRequire('Automator')
let _commonFunctions = singletonRequire('CommonFunction')
let fileUtils = singletonRequire('FileUtils')
let OpenCvUtil = require('../lib/OpenCvUtil.js')
let localOcrUtil = require('../lib/LocalOcrUtil.js')
let WarningFloaty = singletonRequire('WarningFloaty')
let YoloTrainHelper = singletonRequire('YoloTrainHelper')
let YoloDetection = singletonRequire('YoloDetectionUtil')

let BaseScanner = require('./BaseScanner.js')

const DuplicateChecker = function () {

  this.duplicateChecked = {}

  /**
   * 校验是否全都重复校验过了
   */
  this.checkIsAllDuplicated = function () {
    if (Object.keys(this.duplicateChecked).length === 0) {
      return false
    }
    for (let key in this.duplicateChecked) {
      if (this.duplicateChecked[key].count <= 2) {
        return false
      }
    }
    return true
  }

  /**
   * 记录 白名单、保护罩好友 重复访问次数的数据
   * @param {*} obj 
   */
  this.pushIntoDuplicated = function (obj) {
    let exist = this.duplicateChecked[obj.name]
    if (exist) {
      exist.count++
    } else {
      exist = { name: obj.name, count: 1 }
    }
    this.duplicateChecked[obj.name] = exist

  }

  /**
   * 收集过1个好友后，重置白名单缓存计数
   * 用以确保连续遇到白名单好友才退出逛一逛
   */
  this.resetAll = function () {
    Object.keys(this.duplicateChecked).forEach(key => {
      this.duplicateChecked[key].count = 0
    })
  }

}

const StrollScanner = function () {
  BaseScanner.call(this)
  // 新版蚂蚁森林好友界面不再需要识别能量球，进入好友页后直接点击“一键收”
  this.force_one_key_collect = true
  this.duplicateChecker = new DuplicateChecker()
  this.first_check = true
  this.init = function (option) {
    this.current_time = option.currentTime || 0
    this.increased_energy = option.increasedEnergy || 0
    this.group_execute_mode = option.group_execute_mode || false
    this.createNewThreadPool()
  }

  this.start = function () {
    debugInfo('逛一逛即将开始')
    if (_config.regenerate_stroll_button_every_loop) {
      debugInfo('重新识别逛一逛按钮: ' + regenerateStrollButton())
    }
    return this.collecting()
  }

  this.destroy = function () {
    debugInfo('逛一逛结束')
    this.baseDestroy()
  }

  /**
   * 执行收集操作
   * 
   * @return { true } if failed
   * @return { minCountdown, lostSomeone } if successful
   */
  this.collecting = function () {
    let hasNext = true
    let region = getEffectiveStrollRegion()
    if (_config.stroll_button_regenerate || this._regenerate_stroll_button) {
      let successful = regenerateStrollButton()
      if (!successful) {
        warnInfo('自动识别逛一逛按钮失败，使用比例兜底区域继续尝试', true)
      }
      region = getEffectiveStrollRegion()
    }
    while (hasNext) {
      if (this.duplicateChecker.checkIsAllDuplicated()) {
        debugInfo('全部都在白名单，没有可以逛一逛的了')
        break
      }
      logInfo('点击找能量进入下一个好友')
      this.visualHelper.addRectangle('准备点击下一个', region)
      WarningFloaty.addRectangle('逛一逛按钮区域', region, '#00ff00')
      this.visualHelper.displayAndClearAll()
      // 直接点击中间位置
      automator.click(region[0] + region[2] / 2, region[1] + region[3] / 2)
      sleep(300)
      hasNext = this.collectTargetFriend()
      if (hasNext) {
        // 新版蚂蚁森林流程：收取完当前好友能量后，需要按返回键回到自己的森林主页，
        // 再重新点击"找能量"进入下一个好友，如此循环直到所有好友能量收取完毕
        this.backToOwnHomePage()
      }
    }
    WarningFloaty.clearAll()
    let result = { regenerate_stroll_button: this._regenerate_stroll_button }
    Object.assign(result, this.getCollectResult())
    return result
  }

  this.backToListIfNeeded = function (rentery, obj, temp) {
    if (!rentery) {
      debugInfo('当前好友能量收取完毕，等待200ms后返回自己的森林主页')
      sleep(200)
      return true
    } else {
      debugInfo('二次校验好友信息，等待250ms')
      sleep(250)
      obj.recheck = true
      return this.doCollectTargetFriend(obj, temp)
    }
  }

  // 保存父类 doCollectTargetFriend 以便回退
  let _parentDoCollectTargetFriend = this.doCollectTargetFriend
  /**
   * 覆盖父类方法：强制一键收模式下，新版好友页是canvas渲染，
   * 跳过所有基于控件树的能量统计/浇水/森林赠礼/小队能量等无效等待，
   * 只做：点击一键收 → 记录结果 → 返回
   */
  this.doCollectTargetFriend = function (obj, toastListenThread) {
    if (!this.force_one_key_collect) {
      return _parentDoCollectTargetFriend.call(this, obj, toastListenThread)
    }
    let friendStart = new Date().getTime()
    logInfo(['开始收取好友「{}」', obj.name])
    this.target = obj.name
    this.collectEnergy()
    if (this.collect_operated) {
      this.collect_any = true
      logInfo(['好友「{}」一键收完成，耗时{}ms', obj.name, new Date().getTime() - friendStart])
    } else {
      this.failed_count = (this.failed_count || 0) + 1
      warnInfo(['好友「{}」一键收未成功，耗时{}ms', obj.name, new Date().getTime() - friendStart])
    }
    events.removeAllListeners('toast')
    return this.backToListIfNeeded(false, obj)
  }

  /**
   * 返回自己的森林主页
   * 新版蚂蚁森林在收取完好友能量后，需要按返回键回到自己的森林主页，
   * 之后才能重新点击“找能量”进入下一个好友页面
   */
  this.backToOwnHomePage = function () {
    // 收集完好友能量后当前一般处于好友首页，直接按返回键即可回到自己的森林主页
    let tryCount = 1
    while (tryCount <= 3) {
      debugInfo(['返回自己的森林主页，第{}次', tryCount])
      automator.back()
      sleep(500)
      if (_widgetUtils.homePageWaiting()) {
        logInfo(['已返回自己的森林主页，尝试次数：{}', tryCount])
        return true
      }
      tryCount++
    }
    warnInfo('返回自己的森林主页失败，可能界面异常', true)
    return false
  }

  this.doIfProtected = function (obj) {
    //
  }

  /**
   * 逛一逛模式进行特殊处理
   */
  this.getFriendName = function () {
    let friendNameGettingRegex = _config.friend_name_getting_regex || '(.*)的蚂蚁森林'
    let titleContainer = _widgetUtils.alternativeWidget(friendNameGettingRegex, _config.stroll_end_ui_content || /找能量共获得.*/, null, true, null, { algorithm: 'PVDFS' })
    if (titleContainer.value === 1) {
      let regex = new RegExp(friendNameGettingRegex)
      if (titleContainer && regex.test(titleContainer.content)) {
        return regex.exec(titleContainer.content)[1]
      } else {
        errorInfo(['获取好友名称失败，请检查好友首页文本"{}"是否存在', friendNameGettingRegex])
      }
    }
    debugInfo(['未找到{} {}', friendNameGettingRegex, titleContainer.value === 2 ? '找到了逛一逛结束标志' : ''])
    return false
  }
}

StrollScanner.prototype = Object.create(BaseScanner.prototype)
StrollScanner.prototype.constructor = StrollScanner

StrollScanner.prototype.collectTargetFriend = function () {
  let obj = {}
  debugInfo('等待进入好友主页')
  let restartLoop = false
  let count = 1
  ///sleep(1000)
  let alternativeFriendOrDone = 0
  if (auto.clearCache) {
    let start = new Date().getTime()
    auto.clearCache()
    debugInfo(['刷新根控件成功: {}ms', (new Date().getTime() - start)])
  }
  if (_config.friend_home_check_regex.indexOf('的蚂蚁森林') < 0) {
    _config.overwrite('friend_home_check_regex', _config.friend_home_check_regex + '|.*的蚂蚁森林')
  }
  // 未找到好友首页控件 循环等待（H5页面切换约需2秒，按500ms轮次共等待4秒）
  let blindRetryCount = 0
  while ((alternativeFriendOrDone = _widgetUtils.alternativeWidget(_config.friend_home_check_regex, _config.stroll_end_ui_content || /找能量共获得.*/, null, false, null, { algorithm: 'PVDFS' })) !== 1) {
    // 找到了结束标志信息 停止逛一逛
    let ended = false
    if (alternativeFriendOrDone === 2) {
      debugInfo('逛一逛啥也没有，不再瞎逛')
      ended = true
      this.checkDailyReward()
    }
    if (this.checkAndCollectRain()) {
      ended = true
    }
    if (ended) {
      return false
    }
    debugInfo(
      '未能进入主页，等待500ms count:' + count++
    )
    sleep(500)
    if (count >= 8) {
      // 超时后先盲重试点击逛一逛按钮（最多2次），避免H5加载慢被误判为按钮不正确
      if (blindRetryCount < 2 && !this.regenerated_stroll_button) {
        blindRetryCount++
        warnInfo(['未能进入好友主页，第{}次盲重试点击逛一逛按钮', blindRetryCount])
        let retryRegion = getEffectiveStrollRegion()
        automator.clickRandomRegion({ left: retryRegion[0], top: retryRegion[1], width: retryRegion[2], height: retryRegion[3] })
        sleep(1200)
        count = 1
        continue
      }
      if (!this.regenerated_stroll_button) {
        warnInfo(['可能逛一逛按钮不正确，重新识别'])
        if (regenerateStrollButton()) {
          let region = [_config.stroll_button_left, _config.stroll_button_top, _config.stroll_button_width, _config.stroll_button_height]
          automator.clickRandomRegion({ left: region[0], top: region[1], width: region[2], height: region[3] })
          sleep(1000)
          this.regenerated_stroll_button = true
          continue
        }
      }
      this._regenerate_stroll_button = true
      warnInfo('重试超过3次，取消操作')
      warnInfo(['无法确认是否进入好友主页，请检查`判断是否进入好友首页`的控件文本配置是否正确，当前值：{}', _config.friend_home_check_regex])
      warnInfo(['或者检查一下逛一逛按钮的位置是否正确，当前按钮区域：{}', JSON.stringify([_config.stroll_button_left, _config.stroll_button_top, _config.stroll_button_width, _config.stroll_button_height])])
      WarningFloaty.addRectangle('逛一逛按钮区域不正确', [_config.stroll_button_left, _config.stroll_button_top, _config.stroll_button_width, _config.stroll_button_height], '#ff0000')
      WarningFloaty.addText('逛一逛按钮区域不正确', { x: _config.device_width * 0.4, y: _config.device_height * 0.5 }, '#ff0000', 30)
      restartLoop = true
      break
    }
  }
  if (restartLoop) {
    errorInfo('页面流程出错，跳过好友能量收集')
    return false
  }
  let name = this.getFriendName()
  if (name) {
    obj.name = name
    debugInfo(['进入好友[{}]首页成功', obj.name])
    if (name == this.lastFriendName) {
      this.duplicateEnterCount = (this.duplicateEnterCount ? this.duplicateEnterCount : 0) + 1
    } else {
      this.duplicateEnterCount = 0
    }
    if (this.duplicateEnterCount >= 3) {
      this._regenerate_stroll_button = true
      warnInfo(['重复卡在一个好友界面，可能逛一逛按钮区域不正确，重新识别'], true)
      return false
    }
    this.lastFriendName = name
  } else {
    this.checkAndCollectRain()
    return false
  }
  let skip = false
  if (!skip && _config.white_list && _config.white_list.indexOf(obj.name) >= 0) {
    debugInfo(['{} 在白名单中不收取他', obj.name])
    skip = true
  }
  if (!skip && _commonFunctions.checkIsProtected(obj.name)) {
    warnInfo(['{} 使用了保护罩 不收取他', obj.name])
    skip = true
  }
  if (skip) {
    return true
  }
  if (!obj.recheck) {
    // 增加延迟 避免展开好友动态失败
    sleep(100)
    this.protectInfoDetect(obj.name)
  } else {
    this.isProtected = false
    this.isProtectDetectDone = true
  }
  this.saveButtonRegionIfNeeded()
  if (this.first_check) {
    // 当前在好友界面已经无法使用双击卡了，只能选择赠送
    _widgetUtils.checkAndUseDuplicateCard()
    this.first_check = false
  }
  let result = this.doCollectTargetFriend(obj)
  if (!this.collect_any) {
    // 未收取任何能量，可能在保护罩或者白名单中，亦或者发生了异常或识别出错 将其放入重复队列
    this.duplicateChecker.pushIntoDuplicated(obj)
  } else {
    this.duplicateChecker.resetAll()
  }
  return result
}

StrollScanner.prototype.checkDailyReward = function () {
  if (_commonFunctions.checkStrollRewardCollected()) {
    return
  }
  if (localOcrUtil.enabled) {
    let screen = _commonFunctions.checkCaptureScreenPermission()
    if (!screen) {
      errorInfo(['获取截图失败 无法校验每日奖励'])
      return
    }
    let collectPoint = null, collect = null
    let rewardBtn = localOcrUtil.recognizeWithBounds(screen, null, '领取')
    if (rewardBtn && rewardBtn.length > 0) {
      collect = rewardBtn[0].bounds
      debugInfo('OCR找到了 奖励')
    }
    if (collect) {
      collectPoint = {
        centerX: collect.centerX(),
        centerY: collect.centerY()
      }
    }

    if (collectPoint) {
      automator.click(collectPoint.centerX, collectPoint.centerY)
      _commonFunctions.setStrollRewardCollected()
    }
  }
}


StrollScanner.prototype.checkAndCollectRain = function () {
  let target = null
  auto.clearCache && auto.clearCache()
  if ((target = _widgetUtils.widgetGetOne(_config.rain_entry_content || '.*能量雨.*', 500, true)) != null) {
    // 首页也有能量雨标志，需要确认是否还停留在首页
    if (_widgetUtils.widgetCheck(_config.home_ui_content, 500)) {
      warnInfo('找到能量雨开始标志，但是当前依旧在个人首页')
      // 重新生成逛一逛按钮区域
      config._regenerate_stroll_button = true
      return false
    }
    if (!_config.collect_rain_when_stroll) {
      debugInfo('找到能量雨开始标志，但是不需要执行能量雨')
      return true
    }
    if (/已完成/.test(target.content)) {
      debugInfo('今日能量雨已完成')
      return true
    }
    sleep(1000)
    debugInfo('找到能量雨开始标志，准备自动执行能量雨脚本')
    if (/去(收取|拯救)/.test(target.content)) {
      WarningFloaty.clearAll()
      automator.clickCenter(target.target)
      sleep(1000)
      let source = fileUtils.getCurrentWorkPath() + '/unit/能量雨收集.js'
      runningQueueDispatcher.doAddRunningTask({ source: source })
      engines.execScriptFile(source, { path: source.substring(0, source.lastIndexOf('/')), arguments: { executeByStroll: true, executorSource: engines.myEngine().getSource() + '' } })
      _commonFunctions.commonDelay(2.5, '执行能量雨[', true, true)
      automator.back()
    } else {
      debugInfo('未找到去收取，执行能量雨脚本失败')
    }
    this.showCollectSummaryFloaty()
    return true
  }
  return false
}

StrollScanner.prototype.saveButtonRegionIfNeeded = function () {
  if (_config.stroll_button_regenerate) {
    _config.overwrite('stroll_button_left', _config.stroll_button_left)
    _config.overwrite('stroll_button_top', _config.stroll_button_top)
    _config.overwrite('stroll_button_width', _config.stroll_button_width)
    _config.overwrite('stroll_button_height', _config.stroll_button_height)
    _config.overwrite('stroll_button_regenerate', false)
    debugInfo(['保存重新生成的逛一逛按钮区域：{}', JSON.stringify([_config.stroll_button_left, _config.stroll_button_top, _config.stroll_button_width, _config.stroll_button_height])])
  }
}
module.exports = StrollScanner


// inner functions

/**
 * 获取有效的逛一逛（找能量）按钮区域，支持不同分辨率
 * 1. 优先使用配置区域，但需校验在屏幕内且中心点比例处于中下部合理范围
 * 2. 配置失效/缺失时按屏幕比例兜底（基于 1220x2712 实测「找能量」中心比例 0.911/0.655）
 */
function getEffectiveStrollRegion () {
  let deviceWidth = _config.device_width
  let deviceHeight = _config.device_height
  if (_config.stroll_button_left && _config.stroll_button_top && _config.stroll_button_width && _config.stroll_button_height) {
    let region = [parseInt(_config.stroll_button_left), parseInt(_config.stroll_button_top), parseInt(_config.stroll_button_width), parseInt(_config.stroll_button_height)]
    _commonFunctions.ensureRegionInScreen(region)
    let centerXRatio = (region[0] + region[2] / 2) / deviceWidth
    let centerYRatio = (region[1] + region[3] / 2) / deviceHeight
    if (centerXRatio > 0.6 && centerXRatio < 0.99 && centerYRatio > 0.5 && centerYRatio < 0.85) {
      return region
    }
    debugInfo(['逛一逛按钮配置区域比例不合理，使用比例兜底: centerX={} centerY={}', centerXRatio.toFixed(3), centerYRatio.toFixed(3)])
  }
  // 比例兜底：按钮中心位于屏幕宽度91%、高度65.5%处，尺寸按比例放大并留裕量
  let regionWidth = Math.max(140, parseInt(deviceWidth * 0.18))
  let regionHeight = Math.max(70, parseInt(deviceHeight * 0.05))
  let centerX = parseInt(deviceWidth * 0.911)
  let centerY = parseInt(deviceHeight * 0.655)
  let region = [centerX - parseInt(regionWidth / 2), centerY - parseInt(regionHeight / 2), regionWidth, regionHeight]
  _commonFunctions.ensureRegionInScreen(region)
  debugInfo(['使用比例兜底逛一逛按钮区域：{}', JSON.stringify(region)])
  return region
}

function refillStrollInfo (region) {
  _config.stroll_button_left = parseInt(region[0])
  _config.stroll_button_top = parseInt(region[1])
  _config.stroll_button_width = parseInt(region[2])
  _config.stroll_button_height = parseInt(region[3])
  // 用于执行保存数值
  _config.stroll_button_regenerate = true

  debugInfo(['重新生成逛一逛按钮区域：{}', JSON.stringify(region)])
}

function ocrFindText (screen, text, tryTime) {
  tryTime = tryTime || 0
  let ocrCheck = localOcrUtil.recognizeWithBounds(screen, null, text)
  if (ocrCheck && ocrCheck.length > 0) {
    return ocrCheck[0]
  } else {
    if (--tryTime > 0) {
      sleep(500)
      return ocrFindText(screen, text, tryTime)
    }
    return null
  }
}

function regenerateByYolo (screen) {
  let yoloCheck = YoloDetection.forward(screen, { labelRegex: 'stroll_btn' })
  if (yoloCheck && yoloCheck.length > 0) {
    let bounds = yoloCheck[0]
    region = [
      bounds.x, bounds.y,
      bounds.width, bounds.height
    ]
    refillStrollInfo(region)
    return true
  }
  return false

}

function regenerateByOcr (screen) {
  // OCR对「找能量」的识别不稳定（实测可能出现「-我能量>」「-找能量>」等误差），
  // 改用宽松正则：匹配以「能量」+「>」结尾的短文本，避免误匹配「TA待收的能量」等无>文本
  let ocrCheck = ocrFindText(screen, '.{0,3}能量\\s*>', 1)
  if (ocrCheck) {
    let bounds = ocrCheck.bounds
    if (!bounds) {
      return false
    }
    // 过滤明显不合理的结果：尺寸不超过按钮合理范围，且中心点位于屏幕中下部
    let width = bounds.right - bounds.left
    let height = bounds.bottom - bounds.top
    let centerX = (bounds.left + bounds.right) / 2
    let centerY = (bounds.top + bounds.bottom) / 2
    if (width > _config.device_width * 0.4 || height > _config.device_height * 0.08) {
      debugInfo(['OCR识别到的能量按钮尺寸不合理，忽略: w={} h={}', width, height])
      return false
    }
    if (centerY < _config.device_height * 0.55 || centerY > _config.device_height * 0.85) {
      debugInfo(['OCR识别到的能量按钮位置不合理，忽略: centerY={}', centerY])
      return false
    }
    region = [
      bounds.left, bounds.top,
      width, height
    ]
    refillStrollInfo(region)
    return true
  }
  return false
}

function regenerateByImg (screen) {
  let configImageFail = false
  let imagePoint = OpenCvUtil.findByGrayBase64(screen, _config.image_config.stroll_icon)
  if (!imagePoint) {
    configImageFail = true
    imagePoint = OpenCvUtil.findBySIFTGrayBase64(screen, _config.image_config.stroll_icon)
  }
  if (imagePoint) {
    region = [
      Math.floor(imagePoint.left), Math.floor(imagePoint.top),
      imagePoint.width(), imagePoint.height()
    ]
    if (region[0] + region[2] > _config.device_width) {
      region[2] = _config.device_width - region[0]
    }
    if (region[1] + region[3] > _config.device_height) {
      region[3] = _config.device_height - region[1]
    }
    if (configImageFail) {
      logInfo(['找到目标区域，截图保存：{}', JSON.stringify(region)])
      let croppedImage = images.clip(images.cvtColor(images.grayscale(screen), 'GRAY2BGRA'), region[0], region[1], region[2], region[3])
      _config.overwrite('image_config.stroll_icon', images.toBase64(croppedImage))
    }
    refillStrollInfo(region)
    _commonFunctions.ensureRegionInScreen(region)
    return true
  }
  return false
}

function regenerateStrollButton () {
  if (!_config.image_config.stroll_icon && !localOcrUtil.enabled) {
    warnInfo(['请配置逛一逛按钮图片或者手动指定逛一逛按钮区域'], true)
    return false
  }
  let screen = _commonFunctions.checkCaptureScreenPermission()
  if (!screen) {
    errorInfo(['获取截图失败'])
    return false
  }
  YoloTrainHelper.saveImage(screen, '识别逛一逛按钮')
  let successful = false
  if (YoloDetection.enabled) {
    successful = regenerateByYolo(screen)
  }
  if (!successful && !(successful = regenerateByOcr(screen))) {
    successful = regenerateByImg(screen)
  }
  return successful
}
