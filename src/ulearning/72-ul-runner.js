// ========================= 22. 优学院主流程（Runner 状态机） =========================

function uProcessVideoWithRetry(entry, element, cardKey) {
	return (async () => {
		let lastErr = null;
		for (let attempt = 1; attempt <= CFG.maxJobRetries; attempt++) {
			if (S.stopRequested) throw STOP;
			try {
				Log.use(cardKey);
				Panel.setStatus("运行中");
				Panel.setTask("分析视频：" + entry.title);
				const via = await uHandleVideoElement(entry, element, cardKey);
				Panel.setTask("当前视频任务点完成");
				return via;
			} catch (e) {
				if (e === STOP) throw e;
				lastErr = e;
				Log.use(cardKey);
				Log.error(
					"处理异常（第 " +
						attempt +
						"/" +
						CFG.maxJobRetries +
						" 次）：" +
						((e && e.message) || e),
				);
				if (attempt < CFG.maxJobRetries) {
					Panel.setStatus("等待中");
					Panel.setTask("等待重试");
					await sleep(3000);
				}
			}
		}
		Log.use(cardKey);
		Panel.setStatus("异常");
		Log.error("重试后仍未完成，跳过并继续后续任务（" + ((lastErr && lastErr.message) || lastErr) + "）");
		await sleep(1500);
		return null;
	})();
}

async function uRun() {
	S.stopRequested = false;
	S.videoSeen = 0;
	S.videoDone = 0;
	S.answerSeen = 0;
	S.answerDone = 0;
	S.lessonIdx = -1;
	Panel.setTask("准备中");
	Panel.clearCards();
	UL_NAV_LOGGED = false;
	Log.useSystem();

	Log.info("开始扫描课程目录");
	const vm = await uWaitVm();
	const entries = uScanEntries(vm);
	if (!entries.length) throw new Error("未找到学习页面，页面结构可能已变化");
	Log.info("找到 " + entries.length + " 个学习页面");

	const startExpired = uIsExpired(vm);
	if (startExpired)
		Log.warn("当前课程/章节已结束：可继续浏览与播放，但站点不会保存学习记录");

	let startIdx = uEntryByPage(entries, vm.currentPage());
	if (startIdx < 0) {
		startIdx = 0;
		Log.warn("未识别当前页面，从第一个学习页面开始");
	} else if (startIdx > 0) {
		Log.info("从当前页面开始（第 " + (startIdx + 1) + " / " + entries.length + " 页）");
	}

	let skippedDone = 0;
	let skippedQuiz = 0;
	let completedPages = 0;
	let expiredPages = 0;
	let skippedQuestions = 0;
	let lessonErrors = 0;

	Panel.setStatus("运行中");

	for (let i = startIdx; i < entries.length; i++) {
		if (S.stopRequested) throw STOP;
		const entry = entries[i];
		S.lessonIdx = i;
		Panel.setLesson(i + 1 + " / " + entries.length + "　" + entry.title);

		// 先读小节记录，已完成页面直接跳过（不建卡片，避免日志刷屏）
		await uEnsureSectionRecord(entry.section);
		if (uPageComplete(entry.page)) {
			skippedDone++;
			continue;
		}

		const profile = uPageProfile(entry.page);
		const lessonKey = "lesson:" + entry.page.id();

		// 纯练习页面：暂不支持自动答题，直接跳过，不进入页面（避免站点“未完成练习”拦截弹窗）
		if (
			profile.loaded &&
			profile.total > 0 &&
			profile.videos.length === 0 &&
			profile.quizzes.length > 0
		) {
			Log.use(lessonKey, {
				kind: "job",
				title: "课时任务",
				badge: "已跳过",
				badgeCls: "",
			});
			Log.info("检查：" + entry.title + "（" + (i + 1) + "/" + entries.length + "）");
			Log.skip("该页面仅包含练习/答题任务点，已跳过（" + PLATFORM.name + "暂不支持自动答题）");
			skippedQuiz++;
			skippedQuestions += profile.quizzes.length;
			Log.meta(null, "已跳过", "");
			continue;
		}

		const lessonKind = profile.videos.length
			? "video"
			: profile.quizzes.length
				? "job"
				: "sys";
		Log.use(lessonKey, {
			kind: lessonKind,
			title: "课时任务",
			badge: "进行中",
			badgeCls: "run",
		});
		Log.info("进入：" + entry.title + "（" + (i + 1) + "/" + entries.length + "）");

		let lessonHadError = false;
		let lessonHadSkip = false;
		let lessonVideos = 0;

		try {
			await uGoToPage(entry, lessonKey);
			Log.use(lessonKey);
			const pageExpired = uIsExpired(vm);

			const els = entry.page.pageElements();
			if (!els.length) {
				Log.skip("当前页面不包含可处理的学习任务点");
			}

			for (const el of els) {
				if (S.stopRequested) throw STOP;
				const type = Number(el.type && el.type());
				if (type === 4) {
					S.videoSeen++;
					lessonVideos++;
					Panel.setStatus("运行中");
					const via = await uProcessVideoWithRetry(entry, el, lessonKey);
					if (via) S.videoDone++;
					else lessonHadError = true;
				} else if (type === 6) {
					S.answerSeen++;
					skippedQuestions++;
					lessonHadSkip = true;
					Log.use(lessonKey);
					Log.skip(
						"跳过练习/答题任务点（" +
							PLATFORM.name +
							"暂不支持自动答题，请在该页面手动完成）",
					);
				} else if (uIsPassiveType(type)) {
					/* 图文类内容随页面浏览，无需单独操作 */
				} else {
					lessonHadSkip = true;
					Log.use(lessonKey);
					Log.skip("跳过其他任务点（类型：" + uElementTypeName(type) + "）");
				}
			}

			Log.use(lessonKey);
			const complete = uRefreshPageRecord(entry.page);
			let outcome = "done"; // done | played | viewed | partial | error
			if (complete) {
				completedPages++;
				Log.ok("课时学习完成");
			} else if (lessonHadError) {
				outcome = "error";
				Log.warn("课时仍有未完成的任务点");
			} else if (pageExpired) {
				expiredPages++;
				if (lessonVideos > 0) {
					outcome = "played";
					Log.warn("课时视频已播放完毕；已结束课程不更新学习记录");
				} else if (lessonHadSkip) {
					outcome = "partial";
					Log.skip("课时仍有未处理的练习/其他任务点；已结束课程不更新学习记录");
				} else {
					outcome = "viewed";
					Log.warn("课时已浏览；已结束课程不更新学习记录");
				}
				if (lessonVideos > 0 && lessonHadSkip)
					Log.skip("课时含未处理的练习/其他任务点，请手动完成");
			} else if (lessonHadSkip) {
				outcome = "partial";
				Log.skip("课时仍有未完成的练习/其他任务点，已跳过");
			} else {
				outcome = "partial";
				Log.warn("课时未标记完成（站点记录可能延迟）");
			}

			const save = await uSaveSection(entry);
			Log.use(lessonKey);
			if (save === "ok") Log.info("学习记录已保存");
			else if (save === "failed" || save === "timeout")
				Log.warn("学习记录保存未确认（站点将按自身策略重试）");

			Log.info("课时处理完成，准备进入下一个课时");
			Log.meta(
				null,
				outcome === "error"
					? "有异常"
					: outcome === "done"
						? "已完成"
						: outcome === "played"
							? "已播放"
							: outcome === "viewed"
								? "已浏览"
								: "已跳过",
				outcome === "error" ? "err" : outcome === "done" ? "ok" : "",
			);
			await sleep(CFG.navSettleDelay);
		} catch (e) {
			if (e === STOP) throw e;
			lessonHadError = true;
			lessonErrors++;
			Log.use(lessonKey);
			Log.error("处理异常：" + ((e && e.message) || e));
			Log.meta(null, "有异常", "err");
			await sleep(1500);
		}
	}

	// ---- FINISHED ----
	store.set(RUNNING_KEY, false);
	Panel.setStatus("已完成");
	Panel.setTask("全部完成");
	Log.useSystem();
	if (skippedDone) Log.skip("跳过 " + skippedDone + " 个已完成的学习页面");
	if (skippedQuiz) Log.skip("跳过 " + skippedQuiz + " 个纯练习页面");
	if (expiredPages > 0) {
		Log.info(
			"课程处理完毕（其中 " +
				expiredPages +
				" 个页面处于已结束章节）：视频任务点 " +
				S.videoDone +
				"/" +
				S.videoSeen +
				"，未处理的练习任务点 " +
				skippedQuestions +
				" 个" +
				(lessonErrors ? "，异常 " + lessonErrors + " 处" : ""),
		);
	} else {
		Log.info(
			"课程处理完毕：学习页面完成 " +
				completedPages +
				" 个，视频任务点 " +
				S.videoDone +
				"/" +
				S.videoSeen +
				"，未处理的练习任务点 " +
				skippedQuestions +
				" 个" +
				(lessonErrors ? "，异常 " + lessonErrors + " 处" : ""),
		);
	}
	if (skippedQuestions)
		Log.warn(
			PLATFORM.name +
				"暂不支持自动答题：请手动完成上述练习/口语等任务点，方可标记整个课时完成",
		);
	if (expiredPages > 0)
		Log.warn("已结束章节不保存学习记录：本次仅完成本地播放与浏览；可在课程有效期内重新学习以保存进度");
}

const UlRunner = {
	start() {
		if (S.running) return;
		S.running = true;
		store.set(RUNNING_KEY, true);
		uRun()
			.catch((e) => {
				if (e === STOP || S.stopRequested) {
					Log.info("已停止刷课");
					Panel.setStatus("已停止");
				} else {
					Log.error("流程异常终止：" + ((e && e.message) || e));
					Panel.setStatus("异常");
				}
			})
			.then(() => {
				S.running = false;
			});
	},
	stop() {
		S.stopRequested = true;
		store.set(RUNNING_KEY, false);
		S.pending.forEach((item) => {
			if (item.timer) clearTimeout(item.timer);
			try {
				item.reject(STOP);
			} catch (e) {
				/* noop */
			}
		});
		S.pending.clear();
		S.observers.forEach((o) => {
			try {
				o.disconnect();
			} catch (e) {
				/* noop */
			}
		});
		S.observers = [];
		uPauseVideos();
		const rh = document.getElementById("cxap-render-host");
		if (rh) rh.innerHTML = "";
		Panel.setStatus("已停止");
		Panel.setTask("—");
		Log.info("用户停止刷课：已终止定时器与监听，不再自动切换课时");
	},
	wasRunning() {
		return !!store.get(RUNNING_KEY, false);
	},
};
