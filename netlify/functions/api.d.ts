import type { NetlifyEvent, NetlifyContext } from "./types";
export declare function handler(event: NetlifyEvent, _context: NetlifyContext): Promise<{
    statusCode: number;
    headers: {
        "Content-Type": string;
        "Access-Control-Allow-Origin": string;
        "Access-Control-Allow-Methods": string;
        "Access-Control-Allow-Headers": string;
    };
    body: string;
} | {
    statusCode: number;
    headers: {
        "Access-Control-Allow-Origin": string;
        "Access-Control-Allow-Methods": string;
        "Access-Control-Allow-Headers": string;
    };
}>;
