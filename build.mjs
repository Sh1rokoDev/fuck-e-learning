/**
 * 构建脚本：把 src/common、src/chaoxing、src/ulearning 下的模块按文件名顺序拼接为单文件用户脚本。
 * 用法：node build.mjs [--watch]
 *
 * 模块约定：
 *   - 每个文件是一段可直接拼接的 JS 片段（无 import/export）
 *   - 00-header.js 的内容（元数据块 + 调研注释）输出在 IIFE 之外，其余文件包裹进同一个 IIFE
 *   - 按文件名数字前缀排序：common 00-05 → chaoxing 10-60 → ulearning 70-72 → common 90/99
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
const DIRS = ["common", "chaoxing", "ulearning"];
const OUTPUT = join(ROOT, "fuck-e-learning.user.js");
const HEADER_FILE = "00-header.js";

function listModules() {
	const out = [];
	for (const dir of DIRS) {
		const abs = join(SRC, dir);
		for (const f of readdirSync(abs)) {
			if (f.endsWith(".js") && statSync(join(abs, f)).isFile())
				out.push({ dir, file: f, abs: join(abs, f) });
		}
	}
	return out.sort((a, b) =>
		a.file < b.file ? -1 : a.file > b.file ? 1 : a.dir < b.dir ? -1 : 1,
	);
}

function build() {
	const modules = listModules();
	if (!modules.length) throw new Error("src/ 下没有找到任何模块文件");
	const headerIdx = modules.findIndex((m) => m.file === HEADER_FILE);
	if (headerIdx !== 0)
		throw new Error("第一个模块必须是 " + HEADER_FILE + "，当前为 " + modules[0].file);

	const header = readFileSync(modules[0].abs, "utf8").trimEnd();
	const body = modules
		.slice(1)
		.map((m) => {
			const code = readFileSync(m.abs, "utf8").trimEnd();
			return "// >>> " + m.dir + "/" + m.file + "\n" + code;
		})
		.join("\n\n");

	const out =
		header +
		"\n\n(function () {\n\t\"use strict\";\n\n" +
		indent(body, 1) +
		"\n})();\n";

	writeFileSync(OUTPUT, out, "utf8");
	const kb = (Buffer.byteLength(out, "utf8") / 1024).toFixed(1);
	console.log(
		`[build] ${modules.length} modules -> ${basename(OUTPUT)} (${kb} KB, ${out.split("\n").length} lines)`,
	);
	return OUTPUT;
}

/** 整体缩进一级，保持产物可读 */
function indent(text, level) {
	const pad = "\t".repeat(level);
	return text
		.split("\n")
		.map((line) => (line.trim() ? pad + line : line))
		.join("\n");
}

build();

if (process.argv.includes("--watch")) {
	console.log("[build] watching src/ for changes…");
	let lastStamp = "";
	setInterval(() => {
		try {
			const stamp = listModules()
				.map((m) => m.file + ":" + statSync(m.abs).mtimeMs)
				.join("|");
			if (stamp !== lastStamp) {
				if (lastStamp) {
					try {
						build();
					} catch (e) {
						console.error("[build] 失败：" + e.message);
					}
				}
				lastStamp = stamp;
			}
		} catch (e) {
			/* 忽略瞬时读取错误 */
		}
	}, 400);
}
