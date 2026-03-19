#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { v4: uuidv4 } = require('uuid');

// 模块引入
const logger = require('./modules/logger');
const BilibiliDanmu = require('./modules/bilibili-danmu');
const LXMusicAPI = require('./modules/lxmusic-api');
const OBSDisplayServer = require('./obs-display/server');

/**
 * B站直播间点歌机器人 - 重构版
 * 解决了与洛雪音乐播放控制的冲突问题
 */
class MusicBot {
    constructor() {
        // ========== 配置管理 ==========
        this.config = null;
        this.whitelist = { admins: [], vips: [] };
        this.blacklist = { users: [], keywords: [] };

        // ========== 模块实例 ==========
        this.danmu = null;
        this.lxMusic = null;
        this.obsDisplay = null;

        // ========== 播放状态 ==========
        this.playState = {
            mode: 'IDLE',           // IDLE(空闲) | QUEUE(队列播放) | LXMUSIC(洛雪播放)
            isTransitioning: false, // 是否正在切换歌曲
            lastSearchPlay: null,   // 最后searchPlay的歌曲信息
            lastSearchTime: 0,      // 最后searchPlay的时间
            retryCount: 0          // 当前歌曲重试次数
        };

        // ========== 队列管理 ==========
        this.queue = [];            // 点歌队列
        this.currentSong = null;    // 当前播放的歌曲请求
        this.nextPrepared = false;  // 下一首是否已准备

        // ========== 用户管理 ==========
        this.cooldowns = new Map();    // 用户冷却时间
        this.userData = new Map();     // 用户统计数据

        // ========== 历史记录 ==========
        this.history = [];
        this.statistics = {
            totalSongs: 0,
            todaySongs: 0,
            startTime: Date.now(),
            lastResetDate: new Date().toDateString()
        };

        // ========== 定时器管理 ==========
        this.timers = {
            progress: null,     // 进度监控定时器
            transition: null,   // 切歌定时器
            autoSave: null,     // 自动保存定时器
            daily: null        // 每日重置定时器
        };

        // ========== 礼物点歌配置 ==========
        this.giftConfig = {
            enabled: true,
            minValue: 10,  // 最小礼物价值（元）
            giftSongs: {   // 特定礼物对应歌曲
                '辣条': null,     // 任意点歌
                'B坷垃': null,    // 任意点歌
                '小电视飞船': '特别歌曲'  // 指定歌曲
            }
        };
    }

    // ==================== 初始化部分 ====================

    async init() {
        try {
            console.clear();
            this.showBanner();

            // 加载配置
            await this.loadAllConfigs();

            // 加载历史数据
            await this.loadHistoryData();

            // 初始化各模块
            await this.initModules();

            // 设置事件处理
            this.setupEventHandlers();

            // 启动定时任务
            this.startScheduledTasks();

            // 检测洛雪音乐是否已经开始播放
            if (this.lxMusic.statusCache.status === 'playing') {
                this.playState.mode = 'LXMUSIC';
            } else {
                this.playState.mode = 'IDLE';
            }

            logger.system('✅ 系统初始化完成！');
            logger.system(`📺 房间号: ${this.config.room.roomId}`);
            logger.system(`🎵 默认音源: ${this.config.lxmusic.defaultSource}`);

            this.showCommands();

        } catch (error) {
            logger.error('初始化失败:', error);
            process.exit(1);
        }
    }

    showBanner() {
        const banner = `
╔════════════════════════════════════════════════════════════╗
║           B站直播间 × LX Music 点歌系统 v2.0.0              ║
║                    💝 重构版 - 稳定可靠                      ║
╚════════════════════════════════════════════════════════════╝`;
        console.log(chalk.cyan(banner));
    }

    async loadAllConfigs() {
        const configDir = path.join(__dirname, 'config');

        // 确保配置目录存在
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        // 加载主配置
        const configPath = path.join(configDir, 'config.json');
        if (fs.existsSync(configPath)) {
            this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            logger.info('✅ 配置文件加载成功');
        } else {
            this.config = this.createDefaultConfig();
            fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
            logger.info('📝 已创建默认配置文件');
        }

        // 加载白名单
        const whitelistPath = path.join(configDir, 'whitelist.json');
        if (fs.existsSync(whitelistPath)) {
            this.whitelist = JSON.parse(fs.readFileSync(whitelistPath, 'utf8'));
        }

        // 加载黑名单  
        const blacklistPath = path.join(configDir, 'blacklist.json');
        if (fs.existsSync(blacklistPath)) {
            this.blacklist = JSON.parse(fs.readFileSync(blacklistPath, 'utf8'));
        }
    }

    createDefaultConfig() {
        return {
            room: {
                roomId: 0,
                ownerUid: 0
            },
            lxmusic: {
                api: {
                    host: "http://localhost",
                    port: 23330,
                    enabled: true
                },
                defaultSource: "tx",
                maxPlayTime: 300,
                preloadTime: 2,  // 提前2秒切换
                retryTimes: 2    // 播放失败重试次数
            },
            obs: {
                enabled: true,
                port: 8888,
                showLyrics: true  // 显示歌词
            },
            limits: {
                maxSongsPerUser: 3,
                maxQueueSize: 50,
                cooldown: {
                    default: 30,
                    vip: 10,
                    admin: 0,
                    owner: 0
                }
            },
            gift: {
                enabled: true,
                minValue: 10
            },
            permissions: {
                "点歌": 0,
                "优先": 1,
                "切歌": 1,
                "插播": 2,
                "清空": 2,
                "拉黑": 2,
                "设置": 3
            }
        };
    }

    async loadHistoryData() {
        const dataDir = path.join(__dirname, 'data');

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // 加载用户数据
        const usersPath = path.join(dataDir, 'users.json');
        if (fs.existsSync(usersPath)) {
            const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
            this.userData = new Map(Object.entries(users));
            logger.info(`📊 加载了 ${this.userData.size} 个用户数据`);
        }

        // 加载历史记录
        const historyPath = path.join(dataDir, 'history.json');
        if (fs.existsSync(historyPath)) {
            this.history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));

            // 限制历史记录数量
            if (this.history.length > 1000) {
                this.history = this.history.slice(-1000);
            }
        }

        // 加载统计数据
        const statsPath = path.join(dataDir, 'statistics.json');
        if (fs.existsSync(statsPath)) {
            const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            this.statistics = { ...this.statistics, ...stats };

            // 检查是否需要重置每日统计
            if (this.statistics.lastResetDate !== new Date().toDateString()) {
                this.statistics.todaySongs = 0;
                this.statistics.lastResetDate = new Date().toDateString();
            }
        }
    }

    async initModules() {
        // 初始化LX Music API
        this.lxMusic = new LXMusicAPI(this.config.lxmusic);
        const apiConnected = await this.lxMusic.init();

        if (!apiConnected) {
            logger.warn('⚠️ LX Music API未连接，功能将受限');
        }

        // 初始化OBS显示服务
        if (this.config.obs?.enabled) {
            try {
                this.obsDisplay = new OBSDisplayServer(this.config.obs.port);
                await this.obsDisplay.start();
                logger.info(`📺 OBS服务已启动: http://localhost:${this.obsDisplay.port}`);
            } catch (error) {
                logger.error('OBS服务启动失败:', error.message);
                this.obsDisplay = null;
            }
        }

        // 初始化B站弹幕连接
        this.danmu = new BilibiliDanmu(
            this.config.room.roomId,
            this.config.room.ownerUid
        );
        this.danmu.connect();
    }

    // ==================== 事件处理 ====================

    setupEventHandlers() {
        // B站弹幕事件
        this.danmu.on('connected', () => {
            logger.info('✅ 已连接到直播间');
        });

        this.danmu.on('danmu', (data) => {
            this.handleDanmu(data);
        });

        this.danmu.on('gift', (gift) => {
            if (this.config.gift?.enabled) {
                this.handleGift(gift);
            }
        });

        // LX Music事件
        this.lxMusic.on('progress', (data) => {
            this.handleProgress(data);
            
            // 监听到当前歌曲即将结束，尝试返回队列
            const remaining =data.duration - data.progress;
            if (remaining >0 && remaining <= this.config.lxmusic.preloadTime && this.queue.length > 0){
                this.playNext();
            }
        });

        this.lxMusic.on('songChanged', (status) => {
            this.handleSongChanged(status);

            // 新增：从 LX Music 获取歌手信息
            console.log('🎵 检测到歌曲变化，状态数据:', status);
            
            // 如果当前歌曲没有歌手信息，从API状态更新
            if (this.currentSong && (!this.currentSong.singer || this.currentSong.singer === '未知歌手' || this.currentSong.singer === '搜索中...') && status.singer) {
                console.log('🎤 从 LX Music 获取到歌手信息:', status.singer);
                this.currentSong.singer = status.singer;
                
                // 更新OBS显示
                if (this.obsDisplay) {
                    this.obsDisplay.updateNowPlaying({
                        song: this.currentSong.name,
                        singer: status.singer,
                        album: status.albumName || '',
                        requester: this.currentSong.requestBy.username,
                        duration: status.duration || this.config.lxmusic.maxPlayTime,
                        pic: status.pic || null
                    });
                }

            }
        });

        this.lxMusic.on('statusChanged', (status) => {
            // 处理播放/暂停/停止状态变化
            if (this.obsDisplay) {
                this.obsDisplay.updatePlayerStatus(status);
            }
        });

        // 进程退出处理
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
    }

    // ==================== 弹幕命令处理 ====================

    handleDanmu(data) {
        const { content, user } = data;

        // 检查黑名单
        if (this.blacklist.users.includes(user.uid)) {
            return;
        }

        // 更新用户活跃度
        this.updateUserActivity(user);

        // 检查是否是命令
        if (!content.startsWith('!') && !content.startsWith('！')) {
            return;
        }

        const command = content.substring(1).trim();
        const [cmd, ...args] = command.split(' ');
        const argStr = args.join(' ').trim();

        // 命令路由
        const commandMap = {
            '点歌': () => this.cmdRequestSong(user, argStr),
            '优先': () => this.cmdPrioritySong(user, argStr),
            '插播': () => this.cmdInsertSong(user, argStr),
            '切歌': () => this.cmdSkipSong(user),
            '歌单': () => this.cmdShowQueue(),
            '队列': () => this.cmdShowQueue(),
            '当前': () => this.cmdShowNowPlaying(),
            '清空': () => this.cmdClearQueue(user),
            '暂停': () => this.cmdPause(user),
            '继续': () => this.cmdResume(user),
            '音源': () => this.cmdShowSource(),
            '切源': () => this.cmdChangeSource(user, argStr),
            '历史': () => this.cmdShowHistory(),
            '统计': () => this.cmdShowStats(),
            '我的': () => this.cmdShowMyInfo(user),
            '拉黑': () => this.cmdBlacklist(user, argStr),
            '解黑': () => this.cmdUnblacklist(user, argStr),
            '帮助': () => this.showCommands()
        };

        const handler = commandMap[cmd];
        if (handler) {
            handler();
        }
    }

    // ==================== 点歌命令实现 ====================

    async cmdRequestSong(user, songInfo) {
        // 权限检查
        if (!this.checkPermission(user, '点歌')) {
            logger.warn(`❌ ${user.username} 没有点歌权限`);
            return;
        }

        // 冷却检查
        const cooldown = this.checkCooldown(user);
        if (cooldown > 0) {
            logger.warn(`⏰ ${user.username} 冷却中，剩余 ${cooldown} 秒`);
            return;
        }

        // 检查队列限制
        if (this.queue.length >= this.config.limits.maxQueueSize) {
            logger.warn('❌ 播放队列已满');
            return;
        }

        // 检查个人限制
        const userSongs = this.queue.filter(s => s.requestBy.uid === user.uid);
        if (userSongs.length >= this.config.limits.maxSongsPerUser) {
            logger.warn(`❌ ${user.username} 已达点歌上限`);
            return;
        }

        // 解析歌曲信息
        const songData = this.parseSongInfo(songInfo);
        if (!songData) {
            logger.warn('❌ 请输入歌名');
            return;
        }

        // 检查黑名单关键词
        if (this.isBlacklistedSong(songData)) {
            logger.warn('❌ 歌曲包含违禁词');
            return;
        }

        // 创建歌曲请求
        const request = this.createSongRequest(songData, user, 0);

        // 添加到队列
        this.queue.push(request);
        this.setCooldown(user);
        this.updateUserStats(user, 'songs', 1);

        logger.song('点歌成功', `${songData.name}${songData.singer ? '-' + songData.singer : ''}`, user.username);
        logger.info(`📊 当前队列: ${this.queue.length}/${this.config.limits.maxQueueSize}`);

        // 更新OBS显示
        if (this.obsDisplay) {
            this.obsDisplay.showNewRequest({
                user: user.username,
                song: songData.name
            });
            this.obsDisplay.updateQueue(this.queue);
        }

        // 如果当前空闲，开始播放
        if (this.playState.mode === 'IDLE') {
            await this.startQueuePlay();
        }
    }

    async cmdPrioritySong(user, songInfo) {
        if (!this.checkPermission(user, '优先')) {
            logger.warn(`❌ ${user.username} 没有优先点歌权限`);
            return;
        }

        const songData = this.parseSongInfo(songInfo);
        if (!songData || this.isBlacklistedSong(songData)) {
            return;
        }

        const request = this.createSongRequest(songData, user, 1);

        // 找到第一个普通优先级的位置
        let insertIndex = this.queue.findIndex(s => s.priority === 0);
        if (insertIndex === -1) insertIndex = this.queue.length;

        this.queue.splice(insertIndex, 0, request);

        logger.song('⭐ 优先点歌', songData.name, user.username);

        if (this.obsDisplay) {
            this.obsDisplay.updateQueue(this.queue);
        }

        if (this.playState.mode === 'IDLE') {
            await this.startQueuePlay();
        }
    }

    async cmdInsertSong(user, songInfo) {
        if (!this.checkPermission(user, '插播')) {
            logger.warn(`❌ ${user.username} 没有插播权限`);
            return;
        }

        const songData = this.parseSongInfo(songInfo);
        if (!songData) return;

        const request = this.createSongRequest(songData, user, 2);

        // 如果正在播放，将当前歌曲放回队列
        if (this.currentSong && this.playState.mode === 'QUEUE') {
            this.queue.unshift(this.currentSong);
        }

        // 立即播放
        this.currentSong = request;
        await this.playSong(request);

        logger.song('🎯 插播', songData.name, user.username);
    }

    async cmdSkipSong(user) {
        if (!this.checkPermission(user, '切歌')) {
            logger.warn(`❌ ${user.username} 没有切歌权限`);
            return;
        }

        logger.info(`⏭️ ${user.username} 执行切歌`);

        if (this.playState.mode !== 'IDLE') {
            // 正在播放中，直接播放下一首
            await this.playNext();

        } else {
            logger.info('当前没有播放');
        }
    }

    cmdClearQueue(user) {
        if (!this.checkPermission(user, '清空')) {
            logger.warn(`❌ ${user.username} 没有清空权限`);
            return;
        }

        const count = this.queue.length;
        this.queue = [];

        logger.info(`🗑️ ${user.username} 清空了队列 (${count}首)`);

        if (this.obsDisplay) {
            this.obsDisplay.updateQueue([]);
        }
    }

    async cmdPause(user) {
        if (!this.checkPermission(user, '切歌')) {
            return;
        }

        await this.lxMusic.control('pause');
        logger.info(`⏸️ ${user.username} 暂停播放`);
    }

    async cmdResume(user) {
        if (!this.checkPermission(user, '切歌')) {
            return;
        }

        await this.lxMusic.control('play');
        logger.info(`▶️ ${user.username} 继续播放`);
    }

    // ==================== 播放控制核心 ====================

    async startQueuePlay() {
        if (this.queue.length === 0) {
            this.playState.mode = 'IDLE';
            logger.info('⚠️ 点歌异常，播放队列为空，保持空闲状态');
            return;
        }

        this.playState.mode = 'QUEUE';
        await this.playNext();
    }

    async playNext() {
        // 🔧 防止重复调用
        if (this.playState.isTransitioning) {
            logger.debug('已在切换中，跳过重复调用');
            return;
        }

        this.playState.isTransitioning = true;

        // 清理所有定时器
        this.clearTransitionTimer();
        this.clearProgressMonitor();

        if (this.queue.length === 0) {
            // 队列空了，释放控制权
            this.currentSong = null;
            this.nextPrepared = false;
            this.playState.isTransitioning = false;

            // 播放洛雪歌单；如果洛雪歌单为空，进入空闲状态
            if (this.lxMusic.getPlaylist) {
                this.playState.mode = 'LXMUSIC';
                await this.lxMusic.control('next');
                logger.info('✅ 队列已全部播放，播放洛雪歌单');
            } else {
                this.playState.mode = 'IDLE';
                logger.info('☕ 队列已全部播放，洛雪进入待机状态');
            }

            if (this.obsDisplay) {
                this.obsDisplay.updateNowPlaying(null);
                this.obsDisplay.updateQueue([]);
            }

            return;
        }

        const request = this.queue.shift();
        logger.info(`🎵 切换到下一首: ${request.name}`);
        await this.playSong(request);
    }

    async playSong(request) {
        this.currentSong = request;
        this.nextPrepared = false;
        this.playState.retryCount = 0;

        logger.song('🎵 开始播放', request.name, request.requestBy.username);

        // 更新状态
        this.playState.lastSearchPlay = request;
        this.playState.lastSearchTime = Date.now();

        // 执行播放
        const success = await this.tryPlaySong(request);

        if (success) {
            // 记录历史
            this.addToHistory(request);
            this.statistics.totalSongs++;
            this.statistics.todaySongs++;

            // 更新OBS
            if (this.obsDisplay) {
                this.obsDisplay.updateNowPlaying({
                    song: request.name,
                    singer: request.singer || '搜索中...',
                    album: '',
                    requester: request.requestBy.username,
                    duration: this.config.lxmusic.maxPlayTime
                });
                this.obsDisplay.updateQueue(this.queue);

                // 获取并显示歌词
                if (this.config.obs?.showLyrics) {
                    this.updateLyrics();
                }
            }

            // 启动进度监控
            this.startProgressMonitor();

        } else {
            // 播放失败，跳到下一首
            logger.error(`❌ 播放失败: ${request.name}`);
            setTimeout(() => this.playNext(), 1000);
        }

        this.playState.isTransitioning = false;
    }

    async tryPlaySong(request, attempt = 1) {
        try {
            const played = await this.lxMusic.searchAndPlay(request.name, request.singer);

            if (played) {
                return true;
            } else if (attempt < this.config.lxmusic.retryTimes) {
                logger.warn(`⚠️ 播放失败，重试 ${attempt}/${this.config.lxmusic.retryTimes}`);
                await new Promise(r => setTimeout(r, 1000));
                return this.tryPlaySong(request, attempt + 1);
            }

            return false;

        } catch (error) {
            logger.error('播放异常:', error.message);

            if (attempt < this.config.lxmusic.retryTimes) {
                await new Promise(r => setTimeout(r, 1000));
                return this.tryPlaySong(request, attempt + 1);
            }

            return false;
        }
    }

    // 🔧 修复后的进度监控方法
    startProgressMonitor() {
        this.clearProgressMonitor();

        let lastProgress = 0;
        let stuckCount = 0;

        // 使用500ms的检查间隔，更精确
        this.timers.progress = setInterval(async () => {
            try {
                const status = await this.lxMusic.getStatus();

                if (!status || !this.currentSong) {
                    return;
                }

                // 检查是否是我们播放的歌
                // if (this.playState.mode !== 'QUEUE') {
                //    this.clearProgressMonitor();
                //    return;
                // }

                const progress = status.progress || 0;
                const duration = status.duration || this.config.lxmusic.maxPlayTime;
                const remaining = duration - progress;

                // 检测卡住
                if (Math.abs(progress - lastProgress) < 0.1) {
                    stuckCount++;
                    if (stuckCount > 20) { // 10秒没进度变化
                        logger.warn('⚠️ 播放卡住，强制切换');
                        await this.playNext();
                        return;
                    }
                } else {
                    stuckCount = 0;
                    lastProgress = progress;
                }

                // 🎯 核心修改：提前切换逻辑
                if (remaining > 0 && remaining <= this.config.lxmusic.preloadTime && !this.nextPrepared) {
                    this.nextPrepared = true;

                    if (this.queue.length > 0) {
                        // 有下一首，立即切换
                        logger.info(`📀 剩余 ${remaining.toFixed(1)} 秒，立即切换到: ${this.queue[0].name}`);

                        // 清除进度监控，防止重复触发
                        this.clearProgressMonitor();

                        // 立即执行切换
                        await this.playNext();
                        return; // 立即返回，避免继续执行

                    } else {
                        // 队列空了，等待歌曲自然结束
                        logger.info(`📭 队列为空，${remaining.toFixed(1)} 秒后释放控制`);

                        // 设置定时器在歌曲结束时清理
                        this.clearTransitionTimer();
                        this.timers.transition = setTimeout(() => {
                            this.currentSong = null;
                            this.clearProgressMonitor();
                            if (this.lxMusic.getPlaylist) {
                                // 洛雪播放列表不为空，进入洛雪播放
                                this.playState.mode = 'LXMUSIC';
                                logger.info('✅ 返回洛雪控制');
                            } else {
                                // 否则进入空闲状态
                                this.playState.mode = 'IDLE';
                            }
                            if (this.obsDisplay) {
                                this.obsDisplay.updateNowPlaying(null);
                            }
                        }, remaining * 1000);
                    }
                }

                // 更新进度显示
                if (this.obsDisplay) {
                    this.obsDisplay.updateProgress(progress, duration);
                }

            } catch (error) {
                // 忽略错误，继续监控
                logger.debug('进度监控错误:', error.message);
            }
        }, 500); // 500ms检查一次，更精确
    }

    clearProgressMonitor() {
        if (this.timers.progress) {
            clearInterval(this.timers.progress);
            this.timers.progress = null;
        }
    }

    clearTransitionTimer() {
        if (this.timers.transition) {
            clearTimeout(this.timers.transition);
            this.timers.transition = null;
        }
    }

    // ==================== 事件处理 ====================

    handleProgress(data) {
        // 限制输出频率
        if (this.currentSong && data.name === this.currentSong.name) {
            // 只在每10%进度时输出
            const percent = Math.floor((data.progress / data.duration) * 10) * 10;
            if (percent !== this.lastLoggedPercent) {
                this.lastLoggedPercent = percent;
                logger.debug(`▶️ 播放进度: ${data.name} [${percent}%]`);
            }
        }
    }

    handleSongChanged(status) {
        // 判断是否是我们触发的变化
        const timeSinceLastSearch = Date.now() - this.playState.lastSearchTime;

        if (timeSinceLastSearch < 3000 && this.playState.lastSearchPlay) {
            // 3秒内的变化，可能是我们触发的
            logger.debug('检测到预期的歌曲变化');
            if (this.currentSong && status.singer) {
                this.currentSong.singer = status.singer;
                logger.info(`🎤 更新歌手信息: ${status.singer}`);
            }
        } else {
            // 非预期变化，可能是洛雪自动切歌
            if (this.playState.mode === 'IDLE') {
                this.playState.mode = 'LXMUSIC';
                logger.info(`🎵 洛雪播放: ${status.name}`);
            }
        }
    }

    async handleGift(gift) {
        // 检查礼物价值
        const value = gift.price * gift.num / 1000; // 转换为元

        if (value >= this.config.gift.minValue) {
            // 自动点一首热门歌曲
            const hotSongs = ['晴天', '青花瓷', '七里香', '稻香', '告白气球'];
            const randomSong = hotSongs[Math.floor(Math.random() * hotSongs.length)];

            logger.info(`🎁 ${gift.uname} 赠送 ${gift.giftName}x${gift.num}，自动点歌: ${randomSong}`);

            const fakeUser = {
                uid: gift.uid,
                username: gift.uname,
                level: 1 // 礼物赠送者视为VIP
            };

            await this.cmdRequestSong(fakeUser, randomSong);
        }
    }

    async updateLyrics() {
        try {
            const lyrics = await this.lxMusic.getLyrics();
            if (lyrics && this.obsDisplay) {
                this.obsDisplay.updateLyrics(lyrics);
            }
        } catch (error) {
            logger.debug('获取歌词失败:', error.message);
        }
    }

    // ==================== 工具函数 ====================

    parseSongInfo(songInfo) {
        if (!songInfo || songInfo.trim() === '') {
            return null;
        }

        const parts = songInfo.split('-').map(s => s.trim());

        return {
            name: parts[0],
            singer: parts[1] || ''
        };
    }

    isBlacklistedSong(songData) {
        const combined = `${songData.name} ${songData.singer}`.toLowerCase();

        return this.blacklist.keywords.some(keyword =>
            combined.includes(keyword.toLowerCase())
        );
    }

    createSongRequest(songData, user, priority = 0) {
        return {
            id: uuidv4(),
            name: songData.name,
            singer: songData.singer,
            requestBy: {
                uid: user.uid,
                username: user.username
            },
            requestTime: new Date().toISOString(),
            priority: priority,
            source: this.config.lxmusic.defaultSource
        };
    }

    checkPermission(user, command) {
        const required = this.config.permissions[command] || 0;

        let userLevel = user.level || 0;

        // 白名单提权
        if (this.whitelist.admins.includes(user.uid)) {
            userLevel = Math.max(userLevel, 2);
        }
        if (this.whitelist.vips.includes(user.uid)) {
            userLevel = Math.max(userLevel, 1);
        }

        return userLevel >= required;
    }

    checkCooldown(user) {
        const now = Date.now();
        const lastTime = this.cooldowns.get(user.uid) || 0;

        let cooldownTime = this.config.limits.cooldown.default;

        if (user.level === 3) cooldownTime = this.config.limits.cooldown.owner;
        else if (user.level === 2) cooldownTime = this.config.limits.cooldown.admin;
        else if (user.level === 1) cooldownTime = this.config.limits.cooldown.vip;

        const remaining = lastTime + cooldownTime * 1000 - now;

        return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }

    setCooldown(user) {
        this.cooldowns.set(user.uid, Date.now());
    }

    updateUserActivity(user) {
        let userData = this.userData.get(user.uid);

        if (!userData) {
            userData = {
                username: user.username,
                songs: 0,
                messages: 0,
                gifts: 0,
                firstSeen: Date.now(),
                lastSeen: Date.now()
            };
            this.userData.set(user.uid, userData);
        }

        userData.username = user.username;
        userData.lastSeen = Date.now();
        userData.messages++;
    }

    updateUserStats(user, field, value = 1) {
        let userData = this.userData.get(user.uid);

        if (!userData) {
            userData = {
                username: user.username,
                songs: 0,
                messages: 0,
                gifts: 0,
                firstSeen: Date.now(),
                lastSeen: Date.now()
            };
            this.userData.set(user.uid, userData);
        }

        userData[field] = (userData[field] || 0) + value;
    }

    addToHistory(request) {
        this.history.push({
            id: request.id,
            song: request.name,
            singer: request.singer,
            requestBy: request.requestBy.username,
            playTime: new Date().toISOString()
        });

        // 限制历史大小
        if (this.history.length > 1000) {
            this.history = this.history.slice(-1000);
        }
    }

    // ==================== 显示命令 ====================

    cmdShowQueue() {
        console.log(chalk.cyan('\n════════════ 播放队列 ════════════'));

        if (this.currentSong) {
            console.log(chalk.green('🎵 正在播放:'));
            console.log(chalk.green(`   《${this.currentSong.name}》 - ${this.currentSong.requestBy.username}`));
        }

        if (this.queue.length === 0) {
            console.log(chalk.gray('📭 队列为空'));
        } else {
            console.log(chalk.white(`\n📋 待播放 (${this.queue.length}/${this.config.limits.maxQueueSize}):`));

            this.queue.slice(0, 10).forEach((item, index) => {
                const prefix = item.priority === 2 ? '🎯' : item.priority === 1 ? '⭐' : '  ';
                console.log(`${prefix} ${index + 1}. 《${item.name}》 - ${item.requestBy.username}`);
            });

            if (this.queue.length > 10) {
                console.log(chalk.gray(`   ... 还有 ${this.queue.length - 10} 首`));
            }
        }

        console.log(chalk.cyan('════════════════════════════════\n'));
    }

    cmdShowNowPlaying() {
        if (this.currentSong) {
            console.log(chalk.green('\n┌─ 正在播放 ─────────────────'));
            console.log(chalk.green(`│ 🎵 ${this.currentSong.name}`));
            if (this.currentSong.singer) {
                console.log(chalk.green(`│ 🎤 ${this.currentSong.singer}`));
            }
            console.log(chalk.green(`│ 👤 ${this.currentSong.requestBy.username}`));
            console.log(chalk.green('└────────────────────────────\n'));
        } else {
            console.log(chalk.gray('\n💤 当前没有播放\n'));
        }
    }

    cmdShowHistory() {
        console.log(chalk.cyan('\n📜 播放历史 (最近10首):'));

        const recent = this.history.slice(-10).reverse();

        if (recent.length === 0) {
            console.log(chalk.gray('暂无历史'));
        } else {
            recent.forEach((item, index) => {
                const time = new Date(item.playTime).toLocaleTimeString('zh-CN');
                console.log(`${index + 1}. 《${item.song}》 - ${item.requestBy} (${time})`);
            });
        }

        console.log();
    }

    cmdShowStats() {
        const uptime = Math.floor((Date.now() - this.statistics.startTime) / 1000 / 60);

        console.log(chalk.cyan('\n════════════ 系统统计 ════════════'));
        console.log(`运行时��: ${uptime} 分钟`);
        console.log(`总播放数: ${this.statistics.totalSongs} 首`);
        console.log(`今日播放: ${this.statistics.todaySongs} 首`);
        console.log(`活跃用户: ${this.userData.size} 人`);
        console.log(`当前队列: ${this.queue.length} 首`);
        console.log(`播放模式: ${this.playState.mode}`);
        console.log(chalk.cyan('════════════════════════════════\n'));
    }

    cmdShowMyInfo(user) {
        const userData = this.userData.get(user.uid);
        const cooldown = this.checkCooldown(user);

        console.log(chalk.cyan('\n════════════ 我的信息 ════════════'));
        console.log(`用户名: ${user.username}`);
        console.log(`UID: ${user.uid}`);
        console.log(`权限等级: ${'普通用户/VIP/管理员/主播'.split('/')[user.level || 0]}`);
        console.log(`冷却时间: ${cooldown > 0 ? `${cooldown}秒` : '无'}`);

        if (userData) {
            console.log(`点歌次数: ${userData.songs || 0}`);
            console.log(`发言次数: ${userData.messages || 0}`);
        }

        console.log(chalk.cyan('════════════════════════════════\n'));
    }

    cmdShowSource() {
        const sources = {
            'kw': '酷我音乐',
            'kg': '酷狗音乐',
            'tx': 'QQ音乐',
            'wy': '网易云音乐',
            'mg': '咪咕音乐'
        };

        console.log(chalk.cyan(`\n当前音源: ${sources[this.config.lxmusic.defaultSource]} (${this.config.lxmusic.defaultSource})`));
        console.log(chalk.gray('可用: kw, kg, tx, wy, mg\n'));
    }

    cmdChangeSource(user, source) {
        if (!this.checkPermission(user, '设置')) {
            logger.warn(`❌ ${user.username} 没有权限`);
            return;
        }

        const validSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
        if (!validSources.includes(source)) {
            logger.warn('❌ 无效的音源');
            return;
        }

        this.config.lxmusic.defaultSource = source;
        this.saveConfig();

        logger.info(`✅ ${user.username} 切换音源到 ${source}`);
    }

    cmdBlacklist(user, targetUid) {
        if (!this.checkPermission(user, '拉黑')) {
            return;
        }

        const uid = parseInt(targetUid);
        if (isNaN(uid)) {
            logger.warn('❌ 无效的UID');
            return;
        }

        if (!this.blacklist.users.includes(uid)) {
            this.blacklist.users.push(uid);
            this.saveBlacklist();
            logger.info(`🚫 ${user.username} 拉黑了 ${uid}`);
        }
    }

    cmdUnblacklist(user, targetUid) {
        if (!this.checkPermission(user, '拉黑')) {
            return;
        }

        const uid = parseInt(targetUid);
        const index = this.blacklist.users.indexOf(uid);

        if (index !== -1) {
            this.blacklist.users.splice(index, 1);
            this.saveBlacklist();
            logger.info(`✅ ${user.username} 解除拉黑 ${uid}`);
        }
    }

    showCommands() {
        console.log(chalk.yellow('\n════════════ 命令列表 ════════════'));
        console.log(chalk.cyan('基础命令:'));
        console.log('  !点歌 歌名      - 点歌');
        console.log('  !歌单          - 查看队列');
        console.log('  !当前          - 当前播放');
        console.log('  !历史          - 播放历史');
        console.log('  !我的          - 个人信息');

        console.log(chalk.green('\nVIP命令:'));
        console.log('  !优先 歌名      - 优先点歌');
        console.log('  !切歌          - 切换下一首');

        console.log(chalk.blue('\n管理员命令:'));
        console.log('  !插播 歌名      - 立即播放');
        console.log('  !清空          - 清空队列');
        console.log('  !拉黑 UID      - 拉黑用户');

        console.log(chalk.magenta('\n主播命令:'));
        console.log('  !切源 源        - 切换音源');

        console.log(chalk.yellow('════════════════════════════════\n'));
    }

    // ==================== 定时任务 ====================

    startScheduledTasks() {
        // 自动保存（每5分钟）
        this.timers.autoSave = setInterval(() => {
            this.saveAllData();
        }, 5 * 60 * 1000);

        // 每日重置
        this.scheduleDailyReset();
    }

    scheduleDailyReset() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        const msUntilMidnight = tomorrow - now;

        this.timers.daily = setTimeout(() => {
            this.statistics.todaySongs = 0;
            this.statistics.lastResetDate = new Date().toDateString();
            logger.system('📅 每日统计已重置');

            // 安排下一次重置
            this.scheduleDailyReset();
        }, msUntilMidnight);
    }

    // ==================== 数据持久化 ====================

    saveAllData() {
        const dataDir = path.join(__dirname, 'data');

        try {
            // 保存用户数据
            fs.writeFileSync(
                path.join(dataDir, 'users.json'),
                JSON.stringify(Object.fromEntries(this.userData), null, 2)
            );

            // 保存历史
            fs.writeFileSync(
                path.join(dataDir, 'history.json'),
                JSON.stringify(this.history, null, 2)
            );

            // 保存统计
            fs.writeFileSync(
                path.join(dataDir, 'statistics.json'),
                JSON.stringify(this.statistics, null, 2)
            );

            // 保存当前状态（崩溃恢复用）
            fs.writeFileSync(
                path.join(dataDir, 'state.json'),
                JSON.stringify({
                    queue: this.queue,
                    currentSong: this.currentSong,
                    playState: this.playState
                }, null, 2)
            );

            logger.debug('💾 数据已自动保存');

        } catch (error) {
            logger.error('保存数据失败:', error.message);
        }
    }

    saveConfig() {
        const configPath = path.join(__dirname, 'config', 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
    }

    saveBlacklist() {
        const blacklistPath = path.join(__dirname, 'config', 'blacklist.json');
        fs.writeFileSync(blacklistPath, JSON.stringify(this.blacklist, null, 2));
    }

    // ==================== 关闭处理 ====================

    async shutdown() {
        logger.info('🛑 正在关闭系统...');

        // 停止所有定时器
        Object.values(this.timers).forEach(timer => {
            if (timer) {
                clearInterval(timer);
                clearTimeout(timer);
            }
        });

        // 保存数据
        this.saveAllData();

        // 关闭模块
        if (this.danmu) {
            this.danmu.disconnect();
        }

        if (this.lxMusic) {
            this.lxMusic.destroy();
        }

        if (this.obsDisplay) {
            this.obsDisplay.close();
        }

        logger.info('✅ 系统已安全关闭');

        setTimeout(() => {
            process.exit(0);
        }, 1000);
    }
}

// ==================== 启动 ====================

if (require.main === module) {
    const bot = new MusicBot();

    bot.init().catch(error => {
        console.error(chalk.red('❌ 启动失败:'), error);
        process.exit(1);
    });
}

module.exports = MusicBot;