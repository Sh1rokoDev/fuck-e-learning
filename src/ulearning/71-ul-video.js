// ========================= 21. 优学院视频任务点处理 =========================

function uRootOf(element) {
	return document.getElementById("pageElement" + element.id());
}

/** 读取播放器当前提供的倍速档位（无倍速插件时返回空数组） */
function uReadRateOptions(root) {
	const out = [];
	if (!root) return out;
	Dom.toArray(root.querySelectorAll(UL_SEL.speedLabel)).forEach((label) => {
		const m = Dom.normText(label.textContent).match(/^(\d+(?:\.\d+)?)\s*x/i);
		if (!m) return;
		const n = parseFloat(m[1]);
		if (!isFinite(n) || n < 0.25 || n > 4) return;
		if (!out.some((x) => Math.abs(x - n) < 0.001)) out.push(n);
	});
	return out.sort((a, b) => a - b);
}

function uFindRateLabel(root, rate) {
	if (!root) return null;
	const labels = Dom.toArray(root.querySelectorAll(UL_SEL.speedLabel));
	for (const label of labels) {
		const m = Dom.normText(label.textContent).match(/^(\d+(?:\.\d+)?)\s*x/i);
		if (m && Math.abs(parseFloat(m[1]) - rate) < 0.001) return label;
	}
	return null;
}

/** 应用倍速：点击站点倍速菜单项（走插件自身逻辑），再兜底同步 video 属性 */
function uApplyRate(root, video, rate) {
	const label = uFindRateLabel(root, rate);
	let viaMenu = false;
	if (label) {
		try {
			label.click();
			viaMenu = true;
		} catch (e) {
			/* noop */
		}
	}
	try {
		if (Math.abs(Number(video.playbackRate) - rate) > 0.001) video.playbackRate = rate;
	} catch (e) {
		/* noop */
	}
	return viaMenu;
}

function uCurrentRate(video) {
	try {
		return Number(video.playbackRate) || 1;
	} catch (e) {
		return 1;
	}
}

/**
 * 优学院倍速控制器：
 *  - 从站点倍速菜单读取课程实际开放的档位（账号无倍速权限时菜单不存在 → 保持 1x）
 *  - 从最高档开始应用，持续观察 2.6 秒，被播放器重置则降低档位重试
 *  - 播放暂停恢复 / 媒体源重载后自动重新应用；反复被重置时判定不支持并回退 1x
 */
function uCreateSpeedController(element, video, cardKey) {
	const pref = store.config("video", VIDEO_DEFAULTS);
	const getRoot = () => uRootOf(element);
	let desired = 1;
	let blocked = false;
	let reapplyCount = 0;
	let lastApplyAt = 0;
	let stableSince = 0;
	let disposed = false;

	const logLine = (level, msg) => {
		Log.use(cardKey);
		Log[level](msg);
	};

	async function observe(rate, windowMs) {
		await sleep(CFG.rateProbeDelay);
		const start = Date.now();
		while (Date.now() - start < windowMs) {
			if (S.stopRequested) throw STOP;
			if (Math.abs(uCurrentRate(video) - rate) > 0.01) return "reset";
			await sleep(220);
		}
		return "ok";
	}

	function block(reason) {
		blocked = true;
		desired = 1;
		reapplyCount = 0;
		uApplyRate(getRoot(), video, 1);
		logLine("warn", "该视频无法使用倍速（" + reason + "），已回退 1x 播放");
	}

	async function arm() {
		if (!pref.autoRate) {
			logLine("info", "自动倍速已关闭，按 1x 播放");
			return 1;
		}
		await sleep(300); // 给倍速插件渲染菜单的时间
		const options = uReadRateOptions(getRoot());
		const candidates = options.filter((r) => r > 1).sort((a, b) => b - a);
		if (!candidates.length) {
			logLine("skip", "未检测到可用倍速选项，保持 1x 播放");
			return 1;
		}
		logLine("info", "检测到倍速档位：" + options.map(fmtRate).join(" / ") + "，尝试最高档");
		const tried = candidates.slice(0, 3);
		for (const rate of tried) {
			if (S.stopRequested) throw STOP;
			logLine("info", "尝试 " + fmtRate(rate) + " 播放");
			uApplyRate(getRoot(), video, rate);
			lastApplyAt = Date.now();
			const verdict = await observe(rate, CFG.rateSettleTimeout);
			if (verdict === "ok") {
				desired = rate;
				reapplyCount = 0;
				stableSince = Date.now();
				logLine("ok", "已开启 " + fmtRate(rate) + " 倍速播放");
				return rate;
			}
			logLine("warn", fmtRate(rate) + " 被播放器重置，继续尝试较低档位");
		}
		block("可用档位均被播放器重置");
		return 1;
	}

	function maintain() {
		if (disposed || blocked || desired <= 1) return;
		const cur = uCurrentRate(video);
		if (Math.abs(cur - desired) < 0.01) {
			if (!stableSince) stableSince = Date.now();
			else if (Date.now() - stableSince > 60000) reapplyCount = 0;
			return;
		}
		stableSince = 0;
		if (Date.now() - lastApplyAt < 1500) return;
		if (reapplyCount >= CFG.rateReapplyLimit) {
			block("倍速被反复重置");
			return;
		}
		reapplyCount++;
		uApplyRate(getRoot(), video, desired);
		lastApplyAt = Date.now();
		logLine(
			"warn",
			"倍速被重置，已重新应用 " +
				fmtRate(desired) +
				"（" +
				reapplyCount +
				"/" +
				CFG.rateReapplyLimit +
				"）",
		);
	}

	function onResume() {
		if (disposed || blocked || desired <= 1) return;
		uApplyRate(getRoot(), video, desired);
		lastApplyAt = Date.now();
	}

	const onLoadedMetadata = () => {
		if (disposed || blocked || desired <= 1) return;
		setTimeout(() => {
			if (disposed || blocked || desired <= 1) return;
			uApplyRate(getRoot(), video, desired);
			lastApplyAt = Date.now();
		}, 350);
	};

	try {
		video.addEventListener("loadedmetadata", onLoadedMetadata);
	} catch (e) {
		/* noop */
	}

	function pause() {
		try {
			video.pause();
		} catch (e) {
			/* noop */
		}
	}

	function dispose() {
		disposed = true;
		try {
			video.removeEventListener("loadedmetadata", onLoadedMetadata);
		} catch (e) {
			/* noop */
		}
	}

	return {
		arm,
		maintain,
		onResume,
		pause,
		dispose,
		getRate: () => uCurrentRate(video),
	};
}

/** 检测视频内弹题（站点会暂停播放并弹出 .video-question-modal） */
function uDetectVideoQuestion(root) {
	if (!root) return null;
	const nodes = Dom.toArray(root.querySelectorAll(UL_SEL.videoQuestionModal));
	for (const el of nodes) {
		if (!Dom.isVisible(el)) continue;
		if (el.classList.contains("in") || el.classList.contains("show")) return el;
		const cs = el.ownerDocument.defaultView.getComputedStyle(el);
		if (cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0")
			return el;
	}
	return null;
}

/**
 * 处理单个视频任务点。
 * 返回判定来源："record"（站点学习记录）| "ended"（播放结束兜底）| "already"（已完成）
 */
async function uHandleVideoElement(entry, element, cardKey) {
	const rec = element.record();
	if (rec.status() === 1) {
		Log.use(cardKey);
		Log.info("视频任务点已完成，跳过");
		return "already";
	}

	const video = await waitFor(
		() => {
			const root = uRootOf(element);
			return (root && root.querySelector(UL_SEL.video)) || null;
		},
		{
			timeout: UL_CFG.videoWaitTimeout,
			interval: 300,
			desc: "优学院视频播放器加载",
		},
	);
	const root = uRootOf(element);

	try {
		video.muted = !!store.get("mute", false);
	} catch (e) {
		/* noop */
	}
	try {
		video.playbackRate = 1;
	} catch (e) {
		/* noop */
	}

	const speedCtl = uCreateSpeedController(element, video, cardKey);
	try {
		Log.use(cardKey);
		await ensurePlay(video);
		Log.info("开始播放视频");

		await waitFor(
			() => (isFinite(video.duration) && video.duration > 0) || video.currentTime > 0,
			{ timeout: UL_CFG.videoMetaTimeout, interval: 500, desc: "视频开始加载" },
		);
		if (isFinite(video.duration) && video.duration > 0) {
			Log.use(cardKey);
			Log.info("时长 " + fmtTime(video.duration) + "，完成条件：观看 ≥ 总时长的 95%");
		}

		await speedCtl.arm();

		let lastPct = -1;
		let lastLogAt = 0;
		let pauseResumes = 0;
		let popupSince = 0;
		let progressAnchor = { t: video.currentTime, at: Date.now() };

		for (;;) {
			if (S.stopRequested) throw STOP;
			await sleep(CFG.monitorInterval);

			const v = video;
			const vm = uGetVm();
			if (vm) uHandleBlockingModal(vm, cardKey);

			// 完成判定 1：站点学习记录（服务端进度 / 已结束课程的本页状态）
			if (rec.status() === 1) {
				await pauseAndSettle(v, speedCtl);
				Log.use(cardKey);
				Log.ok("检测到视频学习完成（站点学习记录状态）");
				return "record";
			}

			// 完成判定 2：播放结束 → 等待记录状态同步
			if (
				v.ended ||
				(isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 1.5)
			) {
				Log.use(cardKey);
				Log.info("播放完成，等待学习记录状态更新…");
				let ok = false;
				try {
					ok = await waitFor(() => rec.status() === 1, {
						timeout: UL_CFG.endedGraceTimeout,
						interval: 800,
						desc: "学习记录状态同步",
					});
				} catch (e) {
					if (e === STOP) throw e;
				}
				await pauseAndSettle(v, speedCtl);
				if (ok) {
					Log.use(cardKey);
					Log.ok("检测到视频学习完成（站点学习记录状态）");
					return "record";
				}
				Log.use(cardKey);
				Log.warn("学习记录状态未更新，按视频播放完成处理（已结束课程不保存记录）");
				return "ended";
			}

			if (v.error) throw new Error("视频播放出错（code=" + v.error.code + "）");

			// 视频内弹题：站点暂停播放等待作答；脚本不代答，只暂停进度看门狗
			const popup = uDetectVideoQuestion(uRootOf(element));
			if (popup) {
				if (!popupSince) {
					popupSince = Date.now();
					Log.use(cardKey);
					Log.warn(
						"检测到视频内弹题，已暂停进度判定，请手动作答后继续（最长等待 " +
							Math.round(CFG.videoPopupWait / 60000) +
							" 分钟）",
					);
				}
				progressAnchor = { t: v.currentTime, at: Date.now() };
				Panel.setTask("视频内弹题：请手动作答");
				if (Date.now() - popupSince > CFG.videoPopupWait) {
					throw new Error(
						"视频内弹题超过 " +
							Math.round(CFG.videoPopupWait / 60000) +
							" 分钟未处理，放弃该视频任务点",
					);
				}
				continue;
			}
			if (popupSince) {
				popupSince = 0;
				Log.use(cardKey);
				Log.info("视频内弹题已处理，继续播放");
			}

			try {
				speedCtl.maintain();
			} catch (e) {
				/* 倍速维护失败不影响播放 */
			}

			// 进度看门狗：只要 currentTime 持续推进就恢复；长时间零进度才判失败
			if (v.currentTime > progressAnchor.t + 0.5) {
				progressAnchor = { t: v.currentTime, at: Date.now() };
			} else if (Date.now() - progressAnchor.at > CFG.noProgressTimeout) {
				throw new Error(
					"视频超过 " +
						Math.round(CFG.noProgressTimeout / 60000) +
						" 分钟无进度推进，放弃该视频任务点",
				);
			}

			if (v.paused) {
				if (pauseResumes >= CFG.maxPauseResumes) {
					throw new Error("视频反复暂停，已达到恢复上限（" + CFG.maxPauseResumes + " 次）");
				}
				pauseResumes++;
				Log.use(cardKey);
				Log.warn("检测到视频被暂停，自动恢复播放（第 " + pauseResumes + " 次）");
				v.muted = !!store.get("mute", false);
				await ensurePlay(v);
				try {
					speedCtl.onResume();
				} catch (e) {
					/* noop */
				}
				continue;
			}

			const hasDur = isFinite(v.duration) && v.duration > 0;
			const pct = hasDur ? Math.min(99, Math.floor((v.currentTime / v.duration) * 100)) : -1;
			const rate = speedCtl.getRate();
			Panel.setTask(
				pct >= 0
					? "播放中 " +
							pct +
							"%（" +
							fmtTime(v.currentTime) +
							" / " +
							fmtTime(v.duration) +
							(rate > 1 ? "，" + fmtRate(rate) : "") +
							"）"
					: "播放中（" + fmtTime(v.currentTime) + (rate > 1 ? "，" + fmtRate(rate) : "") + "）",
			);
			if (pct >= 0 && pct !== lastPct && Date.now() - lastLogAt > CFG.progressLogInterval) {
				lastPct = pct;
				lastLogAt = Date.now();
				Log.use(cardKey);
				Log.info("播放进度：" + pct + "%" + (rate > 1 ? "（" + fmtRate(rate) + "）" : ""));
			}
		}
	} finally {
		try {
			speedCtl.dispose();
		} catch (e) {
			/* noop */
		}
		try {
			video.pause();
		} catch (e) {
			/* noop */
		}
	}
}
