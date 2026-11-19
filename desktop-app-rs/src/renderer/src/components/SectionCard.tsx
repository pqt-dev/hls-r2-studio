import { useId, type ReactNode } from 'react';

/**
 * A titled card (the shared `.card` surface): a heading row with an optional right-aligned
 * `action`, then the body. The section is named by its heading. Screens add layout only.
 */
export function SectionCard({
    title,
    level = 2,
    action,
    description,
    size = 'default',
    className,
    children,
}: {
    title: string;
    /** Heading level: 2 on screens with no page heading above, 3 inside a titled screen. */
    level?: 2 | 3;
    action?: ReactNode;
    /** Muted lines under the title (e.g. a subtitle), kept in the heading's column. */
    description?: ReactNode;
    /** `lg`: a larger title (page-level overview cards). */
    size?: 'default' | 'lg';
    className?: string;
    children: ReactNode;
}) {
    const id = useId();
    const Heading = level === 2 ? 'h2' : 'h3';

    return (
        <section
            className={`card${size === 'lg' ? ' section-card-lg' : ''}${className === undefined ? '' : ` ${className}`}`}
            aria-labelledby={id}
        >
            <div className="section-card-head">
                {description === undefined ? (
                    <Heading id={id} className="section-card-title">
                        {title}
                    </Heading>
                ) : (
                    <div className="section-card-heading">
                        <Heading id={id} className="section-card-title">
                            {title}
                        </Heading>
                        {description}
                    </div>
                )}
                {action}
            </div>
            {children}
        </section>
    );
}
