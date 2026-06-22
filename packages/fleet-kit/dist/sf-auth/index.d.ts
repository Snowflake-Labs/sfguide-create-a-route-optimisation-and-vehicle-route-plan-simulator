export interface SnowflakeAuth {
    baseUrl: string;
    token: string;
    tokenType: 'OAUTH' | 'PROGRAMMATIC_ACCESS_TOKEN';
}
export declare function getSnowflakeAuth(): SnowflakeAuth;
//# sourceMappingURL=index.d.ts.map