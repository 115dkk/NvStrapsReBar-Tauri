export const shortHash = (value?: string) =>
        value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";

export const legacyRuleKey = (catalog: string, ruleId: string) =>
        `${catalog}:${ruleId}`;

export const StatusLine = ({
        label,
        state,
}: {
        label: string;
        state: "ok" | "bad" | "idle";
}) => (
        <span className={`status ${state}`}>
                <i />
                {label}
        </span>
);

export const JourneyHeading = ({
        number,
        title,
        id,
        copy,
}: {
        number: string;
        title: string;
        id: string;
        copy: string;
}) => (
        <div className="section-head journey-head">
                <div>
                        <span className="step">{number}</span>
                        <h3 id={id}>{title}</h3>
                </div>
                <p>{copy}</p>
        </div>
);
