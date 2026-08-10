import { getVirtualNow } from "./virtual-time";

const WEEKDAY_NAMES = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function padTwo(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

export function formatChatUiTime(dateStr: string): string {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "";

    const now = getVirtualNow();
    const hhmm = `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);

    if (date.getTime() >= todayStart.getTime()) {
        return hhmm;
    }
    if (date.getTime() >= yesterdayStart.getTime()) {
        return `昨天 ${hhmm}`;
    }

    const sevenDaysAgo = new Date(todayStart.getTime() - 6 * 86400000);
    if (date.getTime() >= sevenDaysAgo.getTime()) {
        return `${WEEKDAY_NAMES[date.getDay()]} ${hhmm}`;
    }

    if (date.getFullYear() === now.getFullYear()) {
        return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
    }

    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}
