/** In-process S3 look-alike (path-style PutObject, HeadObject, ListObjectsV2, DeleteObjects). */
import {
    createServer,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
    method: string;
    /** Object key for object requests, `''` for bucket-level requests. */
    key: string;
    /** `put` | `head` | `list` | `delete` | `other`. */
    type: string;
    headers: IncomingHttpHeaders;
    bytes: number;
}

export interface FakeS3ServerOptions {
    bucket: string;
    /**
     * Return an HTTP status (e.g. 503) to fail a request instead of handling it, or `'destroy'` to
     * drop the connection without any answer (a network failure).
     */
    failWhen?: (request: RecordedRequest, serial: number) => number | 'destroy' | undefined;
}

export class FakeS3Server {
    readonly requests: RecordedRequest[] = [];
    readonly objects = new Map<string, Buffer>();
    private server: Server | null = null;
    private port = 0;
    private serial = 0;

    constructor(private readonly options: FakeS3ServerOptions) {}

    get endpoint(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    get puts(): RecordedRequest[] {
        return this.requests.filter((r) => r.type === 'put');
    }

    async start(): Promise<void> {
        this.server = createServer((req, res) => {
            // A client that aborts mid-request makes reading the body reject: ignore it.
            this.handle(req, res).catch(() => undefined);
        });
        await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
        this.port = (this.server.address() as AddressInfo).port;
    }

    async stop(): Promise<void> {
        const server = this.server;

        if (server === null) return;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        this.server = null;
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const chunks: Buffer[] = [];

        for await (const chunk of req) chunks.push(chunk as Buffer);

        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const bucketPrefix = `${this.options.bucket}/`;
        const key = path.startsWith(bucketPrefix) ? path.slice(bucketPrefix.length) : '';
        const method = req.method ?? 'GET';

        let type = 'other';
        if (method === 'PUT' && key !== '') type = 'put';
        else if (method === 'HEAD') type = 'head';
        else if (method === 'GET' && url.searchParams.get('list-type') === '2') type = 'list';
        else if (method === 'POST' && url.searchParams.has('delete')) type = 'delete';

        const recorded: RecordedRequest = {
            method,
            key,
            type,
            headers: req.headers,
            bytes: body.length,
        };

        this.requests.push(recorded);

        const failure = this.options.failWhen?.(recorded, ++this.serial);

        if (failure === 'destroy') {
            req.socket.destroy();

            return;
        }

        if (failure !== undefined) {
            res.writeHead(failure, { 'content-type': 'application/xml' });
            res.end('<Error><Code>InternalError</Code><Message>injected</Message></Error>');

            return;
        }

        if (type === 'put') {
            this.objects.set(key, body);
            res.writeHead(200, { etag: '"fake"' });
            res.end();
        } else if (type === 'head') {
            const found = this.objects.get(key);
            res.writeHead(found ? 200 : 404, { 'content-length': String(found?.length ?? 0) });
            res.end();
        } else if (type === 'list') {
            const prefix = url.searchParams.get('prefix') ?? '';
            const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
            const contents = keys
                .map(
                    (k) =>
                        `<Contents><Key>${escapeXml(k)}</Key><Size>${this.objects.get(k)?.length ?? 0}</Size></Contents>`,
                )
                .join('');

            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end(
                `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${this.options.bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
            );
        } else if (type === 'delete') {
            const keys = [...body.toString('utf8').matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) =>
                unescapeXml(m[1] ?? ''),
            );

            for (const k of keys) this.objects.delete(k);
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>');
        } else {
            res.writeHead(400);
            res.end();
        }
    }
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(value: string): string {
    return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
