// ========================= 平台启动入口 =========================

/** 学习通启动流程（与独立版保持一致） */
function cxMain() {
	const ver =
		(typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "1.0.0";
	Log.useSystem();
	Log.info("脚本已加载（v" + ver + "）｜点击「开始刷课」启动");
	const llmCfg = store.config("llm", LLM_DEFAULTS);
	if (llmCfg.apiKey && llmCfg.model) {
		Log.info("自动答题已就绪（模型：" + llmCfg.model + "）");
	} else {
		Log.warn(
			"自动答题未配置：点击面板左上角的齿轮按钮打开「高级设置」，填写 Base URL / API Key / 多模态模型",
		);
	}
	// 请求环境自检：无 GM 时无法绕过 CORS / 混合内容，提前明确告知，避免答题时才失败
	if (!LLM.hasGM()) {
		const pf = LLM.preflight(LLM.endpoint(llmCfg.baseUrl, llmCfg.apiStyle));
		Log.error(
			"当前未运行在油猴环境中（GM_xmlhttpRequest 不可用），模型请求将受浏览器同源策略限制。" +
				"请通过 Tampermonkey 安装并启用本脚本。",
		);
		if (!pf.ok) Log.error(pf.reason);
	}
	const lessons = scanLessons();
	const cur = lessons.find((l) => l.isCurrent);
	Panel.setLesson(
		cur ? lessons.indexOf(cur) + 1 + " / " + lessons.length + "　" + cur.title : "—",
	);
	// 记忆的运行状态：上次未停止则自动续跑（点击「停止」会清除该状态）
	if (CxRunner.wasRunning()) {
		Log.info("检测到刷课处于运行状态，3 秒后自动续跑（点「停止」可取消）");
		Panel.setStatus("等待中");
		Panel.setTask("准备续跑");
		setTimeout(() => {
			if (!S.running && !S.stopRequested) CxRunner.start();
		}, 3000);
	}
	// 调试接口：便于在浏览器控制台定位问题与二次开发（对所有页面脚本可见，仅提供只读引用）
	try {
		window.__CXAP__ = {
			Extract,
			QuestionRenderer,
			Fill,
			AnswerTask,
			AnswerProvider,
			LLM,
			FontTools,
			Dom,
			store,
			S,
			Runner: CxRunner,
			ConfigUI,
			Panel,
			Log,
			CFG,
			LLM_DEFAULTS,
			ANSWER_DEFAULTS,
			VIDEO_DEFAULTS,
			scanCardJobs,
			scanLessons,
			gotoLesson,
			softNavigateLesson,
			pauseCourseVideos,
			Video: {
				getVideoPlayer,
				readRateOptions,
				createSpeedController,
				handleVideoTask,
			},
		};
	} catch (e) {
		/* noop */
	}
}

/** 优学院启动流程 */
function ulMain() {
	const ver =
		(typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "1.0.0";
	Log.useSystem();
	Log.info("脚本已加载（v" + ver + "）｜点击「开始刷课」启动");
	Log.info("当前平台：优学院");
	if (document.body && document.body.classList.contains("expired-mode")) {
		Log.warn("当前章节已结束：可继续浏览与播放，但站点不会保存学习记录");
	}

	uWaitVm(15000)
		.then((vm) => {
			const entries = uScanEntries(vm);
			const idx = uEntryByPage(entries, vm.currentPage());
			Panel.setLesson(
				idx >= 0 ? idx + 1 + " / " + entries.length + "　" + entries[idx].title : "—",
			);
		})
		.catch(() => {
			Log.warn("课程视图尚未就绪，点击「开始刷课」时会重新等待");
		});

	if (UlRunner.wasRunning()) {
		Log.info("检测到刷课处于运行状态，3 秒后自动续跑（点「停止」可取消）");
		Panel.setStatus("等待中");
		Panel.setTask("准备续跑");
		setTimeout(() => {
			if (!S.running && !S.stopRequested) UlRunner.start();
		}, 3000);
	}

	try {
		window.__FEL_UL__ = {
			PLATFORM,
			store,
			S,
			Panel,
			Log,
			CFG,
			VIDEO_DEFAULTS,
			ANSWER_DEFAULTS,
			uGetVm,
			uWaitVm,
			uScanEntries,
			uGoToPage,
			uPageComplete,
			uPageProfile,
			uEnsureSectionRecord,
			uSaveSection,
			uHandleVideoElement,
			uCreateSpeedController,
			Runner: UlRunner,
		};
	} catch (e) {
		/* noop */
	}
}

function main() {
	Panel.ensure();
	if (PLATFORM.id === "chaoxing") return cxMain();
	if (PLATFORM.id === "ulearning") return ulMain();
	Log.error("未识别的平台页面：" + location.hostname);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", main);
} else {
	main();
}
