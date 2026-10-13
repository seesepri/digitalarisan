export const DISPOSABLE_DATABASE_MARKER: string;
export function assertIsolatedTestDatabaseUrl(value: string | undefined): string;
export function assertDisposableTestDatabase(value: string | undefined): Promise<void>;
export function configureTestDatabase(): Promise<string | undefined>;
