/** Inline 24px stroke icons drawn the same way as the design system's Icons set. */
const paths = {
        chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4M18 9h4m-4 6h4M9 9h6v6H9z" /></>,
        more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
        check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
        checkCircle: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.8 2.8L16 10" /></>,
        chevron: <path d="M9 6l6 6-6 6" />,
        arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
        file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
        usb: <><path d="M9 3h6v5H9z" /><path d="M7 8h10v7a5 5 0 0 1-10 0z" /><path d="M12 13v3" /></>,
        restart: <><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></>,
        undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
        tool: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
        alert: <><path d="M12 3.5l9 16H3z" /><path d="M12 10v4.5M12 17.2v.01" /></>,
        info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.01" /></>,
        external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
        gpu: <><rect x="2" y="7" width="20" height="10" rx="1.5" /><circle cx="15" cy="12" r="2.5" /><path d="M6 17v3M10 17v3M5 10.5h4" /></>,
        sliders: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
        save: <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
        swap: <path d="M7 7h12l-3-3M17 17H5l3 3" />,
        clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
        globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
        power: <><path d="M12 3v8" /><path d="M6.3 7.3a8 8 0 1 0 11.4 0" /></>,
        home: <><path d="M4 11l8-7 8 7" /><path d="M6 9.5V20h12V9.5" /></>,
        folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
        game: <><rect x="2" y="7" width="20" height="11" rx="5" /><path d="M7 11v3M5.5 12.5h3M15 12h.01M17.5 14h.01" /></>,
        key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /></>,
        doc: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
        archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>,
} as const;

export type IconName = keyof typeof paths;

export const Icon = ({ name, large = false }: { name: IconName; large?: boolean }) => (
        <svg className={large ? "nv-icon lg" : "nv-icon"} viewBox="0 0 24 24" aria-hidden="true">
                {paths[name]}
        </svg>
);
