"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { isMobileShell } from "@/lib/mobile-shell";

export function useCallKeyboardOffsetStyle(): CSSProperties {
    const [offset, setOffset] = useState(0);

    useEffect(() => {
        if (typeof window === "undefined") return;

        const isAndroidMobile =
            /Android/i.test(navigator.userAgent) && isMobileShell();

        if (isAndroidMobile) {
            setOffset(0);
            return;
        }

        const viewport = window.visualViewport;
        const update = () => {
            if (!viewport) {
                setOffset(0);
                return;
            }
            const next = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
            setOffset(next);
        };

        update();
        viewport?.addEventListener("resize", update);
        viewport?.addEventListener("scroll", update);
        window.addEventListener("resize", update);

        return () => {
            viewport?.removeEventListener("resize", update);
            viewport?.removeEventListener("scroll", update);
            window.removeEventListener("resize", update);
        };
    }, []);

    return useMemo(() => ({ "--call-keyboard-offset": `${offset}px` } as CSSProperties), [offset]);
}
