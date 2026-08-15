class DMarketLogger {
    static lastDebugLogs = [];

    static logDebug(msg, data = null) {
        const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(entry, data || '');
        this.lastDebugLogs.push({ time: new Date().toLocaleTimeString(), msg, data });
        if (this.lastDebugLogs.length > 100) this.lastDebugLogs.shift();
    }

    static getLogs() {
        return this.lastDebugLogs;
    }
}

export { DMarketLogger };
