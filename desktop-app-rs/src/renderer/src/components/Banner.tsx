import type { ReactNode } from 'react';

export type BannerTone = 'info' | 'warning' | 'danger';

const ICON: Record<BannerTone, string> = { info: 'i', warning: '!', danger: '✕' };

export function Banner({
    tone,
    title,
    children,
    action,
}: {
    tone: BannerTone;
    title: string;
    children?: ReactNode;
    action?: ReactNode;
}) {
    return (
        <div className={`banner banner-${tone}`} role={tone === 'info' ? 'status' : 'alert'}>
            <span className="banner-icon" aria-hidden="true">
                {ICON[tone]}
            </span>
            <div className="banner-text">
                <strong>{title}</strong>
                {children !== undefined && <span className="banner-detail"> {children}</span>}
            </div>
            {action !== undefined && <div className="banner-action">{action}</div>}
        </div>
    );
}
