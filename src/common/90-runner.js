// ========================= 平台 Runner 分发 =========================

const Runner = {
	start() {
		if (PLATFORM.id === "chaoxing") return CxRunner.start();
		if (PLATFORM.id === "ulearning") return UlRunner.start();
	},
	stop() {
		if (PLATFORM.id === "chaoxing") return CxRunner.stop();
		if (PLATFORM.id === "ulearning") return UlRunner.stop();
	},
	wasRunning() {
		if (PLATFORM.id === "chaoxing") return CxRunner.wasRunning();
		if (PLATFORM.id === "ulearning") return UlRunner.wasRunning();
		return false;
	},
};
