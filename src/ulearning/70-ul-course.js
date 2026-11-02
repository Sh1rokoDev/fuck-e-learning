// ========================= 20. 优学院课程访问层（扫描 / 记录 / 导航） =========================

const UL_SEL = {
	video: "video",
	speedLabel: ".mejs__speed-selector-label",
	alertModal: "#alertModal",
	videoQuestionModal: ".video-question-modal",
};

const UL_CFG = {
	vmTimeout: 30000, // 等待 Knockout 课程视图就绪
	pageReadyTimeout: 45000, // 等待页面组件渲染完成
	sectionRecordTimeout: 20000, // 读取小节学习记录超时
	navTimeout: 45000, // 页面切换等待超时
	saveTimeout: 15000, // 保存学习记录等待超时
	videoWaitTimeout: 30000, // 等待 video 元素
	videoMetaTimeout: 60000, // 等待视频元数据
	endedGraceTimeout: 20000, // 视频结束后等待学习记录状态同步
};

/** 取优学院课程视图模型（页面未就绪时返回 null） */
function uGetVm() {
	const vm = window.koLearnCourseViewModel;
	if (!vm || !vm.course || typeof vm.selectPage !== "function") return null;
	try {
		if (!vm.course.chapters || !vm.course.chapters().length) return null;
	} catch (e) {
		return null;
	}
	return vm;
}

async function uWaitVm(timeout) {
	return waitFor(() => uGetVm(), {
		timeout: timeout || UL_CFG.vmTimeout,
		interval: 400,
		desc: "优学院课程视图加载",
	});
}

/** 按目录顺序展开全部学习页面 */
function uScanEntries(vm) {
	const out = [];
	const chapters = vm.course.chapters();
	for (let ci = 0; ci < chapters.length; ci++) {
		const chapter = chapters[ci];
		if (chapter.isHide && chapter.isHide() === 1) continue;
		const sections = chapter.sections();
		for (let si = 0; si < sections.length; si++) {
			const section = sections[si];
			const pages = section.pages();
			for (let pi = 0; pi < pages.length; pi++) {
				const page = pages[pi];
				if (page.isHide && page.isHide()) continue;
				out.push({
					page: page,
					section: section,
					chapter: chapter,
					title: page.name(),
					chapterName: chapter.name(),
					sectionName: section.name(),
					ci: ci,
					si: si,
					pi: pi,
				});
			}
		}
	}
	return out;
}

function uEntryByPage(entries, page) {
	for (let i = 0; i < entries.length; i++) {
		if (entries[i].page === page) return i;
	}
	return -1;
}

/** 页面是否已完成（以站点记录的 status 为准） */
function uPageComplete(page) {
	try {
		const rec = page.record && page.record();
		return !!(rec && rec.status && rec.status() === 1);
	} catch (e) {
		return false;
	}
}

/** 页面已加载后，把组件学习状态汇总回页面记录，返回是否完成 */
function uRefreshPageRecord(page) {
	try {
		if (page.isLoaded && page.isLoaded()) page.getRecord();
	} catch (e) {
		/* 汇总失败时退回已有记录 */
	}
	return uPageComplete(page);
}

/** 确保小节学习记录已读取（用于跳过已完成页面） */
async function uEnsureSectionRecord(section) {
	if (!section || (section.isRecordLoaded && section.isRecordLoaded())) return true;
	try {
		if (typeof section.reterieveRecord === "function")
			section.reterieveRecord(
				() => {},
				() => {},
			);
	} catch (e) {
		return false;
	}
	try {
		await waitFor(() => (section.isRecordLoaded ? section.isRecordLoaded() : true), {
			timeout: UL_CFG.sectionRecordTimeout,
			interval: 300,
			desc: "读取小节学习记录",
		});
		return true;
	} catch (e) {
		if (e === STOP) throw e;
		return false;
	}
}

/** 页面元素概况：视频 / 练习 / 其他 */
function uPageProfile(page) {
	const profile = { loaded: false, total: 0, videos: [], quizzes: [], others: [] };
	try {
		profile.loaded = !!(page.isLoaded && page.isLoaded());
		const els = page.pageElements ? page.pageElements() : [];
		profile.total = els.length;
		for (const el of els) {
			const t = Number(el.type && el.type());
			if (t === 4) profile.videos.push(el);
			else if (t === 6) profile.quizzes.push(el);
			else profile.others.push(el);
		}
	} catch (e) {
		/* noop */
	}
	return profile;
}

function uElementTypeName(type) {
	const map = {
		1: "标题",
		2: "文本",
		3: "图片",
		4: "视频",
		5: "音频",
		6: "练习/答题",
		7: "讨论",
		8: "HTML",
		9: "Flash",
		10: "文档",
		11: "综合页面",
		12: "图文块",
		13: "角色扮演",
		14: "音频文字",
		15: "音频文字",
		16: "口语",
		17: "知识点",
	};
	return map[type] || "类型 " + type;
}

/** 纯展示内容（随页面浏览即可，不需要单独操作） */
function uIsPassiveType(type) {
	return [1, 2, 3, 7, 8, 11, 12, 14, 15].indexOf(Number(type)) !== -1;
}

/** 暂停页面上的全部视频（含当前页面之外的残留播放器） */
function uPauseVideos() {
	Dom.toArray(document.querySelectorAll("video")).forEach((v) => {
		try {
			v.pause();
		} catch (e) {
			/* noop */
		}
	});
}

function uModalEl() {
	return document.querySelector(UL_SEL.alertModal);
}

function uModalVisible(modal) {
	if (!modal) return false;
	if (!modal.classList.contains("in")) return false;
	try {
		const cs = window.getComputedStyle(modal);
		return cs.display !== "none" && cs.visibility !== "hidden";
	} catch (e) {
		return true;
	}
}

function uModalType(vm) {
	try {
		return String(vm.modalType() || "");
	} catch (e) {
		return "";
	}
}

/**
 * 处理优学院站点的阻断弹窗：
 *  - 未完成练习 -> 点「确定离开」继续切页
 *  - 长时间无操作 -> 点「继续学习」
 *  - 多页面学习 -> 点「继续学习」
 * 返回本次是否点击了按钮。
 */
function uHandleBlockingModal(vm, cardKey) {
	const modal = uModalEl();
	if (!uModalVisible(modal)) return false;
	const type = uModalType(vm);
	const click = (sel, level, msg) => {
		const btn = modal.querySelector(sel);
		if (!btn) return false;
		try {
			btn.click();
		} catch (e) {
			return false;
		}
		if (cardKey) Log.use(cardKey);
		else Log.useSystem();
		Log[level](msg);
		return true;
	};
	if (
		type === "incomplete" ||
		type === "incompleteOralItem" ||
		type === "incompleteTimeLimit" ||
		type === "goBackCreateRecordFailed"
	) {
		return click(
			".modal-operation .btn-hollow",
			"warn",
			"检测到未完成的练习/口语任务，已点击「确定离开」继续",
		);
	}
	if (type === "suspend") {
		return click(
			".modal-operation .btn-submit",
			"info",
			"检测到长时间无操作弹窗，已点击「继续学习」",
		);
	}
	if (type === "multiLearning") {
		return click(".modal-operation .btn-hollow", "info", "检测到多页面学习提示，已点击「继续学习」");
	}
	return false;
}

/** 等待页面组件渲染完成（当前页面容器与全部页面元素出现） */
async function uWaitPageContent(entry) {
	const vm = uGetVm();
	const page = entry.page;
	const verdict = await waitFor(
		() => {
			if (!vm || vm.currentPage() !== page) return null;
			if (page.loadFailed && page.loadFailed()) return "FAILED";
			if (!page.isLoaded || !page.isLoaded()) return null;
			const els = page.pageElements ? page.pageElements() : [];
			for (const el of els) {
				if (!document.getElementById("pageElement" + el.id())) return null;
			}
			return true;
		},
		{ timeout: UL_CFG.pageReadyTimeout, interval: 250, desc: "优学院页面内容加载" },
	);
	if (verdict === "FAILED") throw new Error("页面加载失败：" + entry.title);
}

let UL_NAV_LOGGED = false;

/**
 * 无刷新切换到指定学习页面。
 * 优先调用站点自身的 selectPage；若当前页有未完成练习，站点会弹窗阻止，
 * 脚本识别后点击「确定离开」，由站点回调继续完成切换。
 */
async function uGoToPage(entry, cardKey) {
	const vm = uGetVm();
	if (!vm) throw new Error("未找到优学院课程视图（页面结构可能已变化）");
	const page = entry.page;
	if (vm.currentPage() === page) return;

	uPauseVideos();
	const deadline = Date.now() + UL_CFG.navTimeout;
	let lastModalClickAt = 0;

	try {
		vm.selectPage(page, entry.section, entry.chapter);
	} catch (e) {
		throw new Error("切换页面失败：" + ((e && e.message) || e));
	}

	for (;;) {
		if (S.stopRequested) throw STOP;
		if (vm.currentPage() === page) break;
		if (Date.now() > deadline) throw new Error("切换页面超时：" + entry.title);
		if (Date.now() - lastModalClickAt > 900) {
			if (uHandleBlockingModal(vm, cardKey)) lastModalClickAt = Date.now();
		}
		await sleep(300);
	}

	await uWaitPageContent(entry);
	if (!UL_NAV_LOGGED) {
		UL_NAV_LOGGED = true;
		Log.useSystem();
		Log.info("页面切换方式：站点内置路由（页面不刷新）");
	}
}

/** 保存当前小节学习记录（已过期课程由站点明确禁止保存，不做调用） */
async function uSaveSection(entry) {
	const vm = uGetVm();
	if (!vm) return "no-vm";
	try {
		if (vm.isExpiredMode && vm.isExpiredMode()) return "expired";
	} catch (e) {
		/* noop */
	}
	const section = entry.section;
	const chapter = entry.chapter;
	if (!section || typeof section.createRecord !== "function") return "skip";
	if (!section.isRecordLoaded || !section.isRecordLoaded()) return "not-ready";

	const failTimesBefore = Number(section.failTimes) || 0;
	let settled = false;
	return await new Promise((resolve) => {
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		try {
			section.createRecord(
				true,
				1,
				chapter.id(),
				() => finish((Number(section.failTimes) || 0) > failTimesBefore ? "failed" : "ok"),
				() => finish("failed"),
			);
		} catch (e) {
			finish("failed");
		}
		setTimeout(() => finish("timeout"), UL_CFG.saveTimeout);
	});
}

/** 优学院当前课程是否处于已结束（不保存记录）模式 */
function uIsExpired(vm) {
	try {
		return !!(vm.isExpiredMode && vm.isExpiredMode());
	} catch (e) {
		return false;
	}
}
