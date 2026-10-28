import type { UpgradeStatus, UpgradeView } from "../shared/api";
export function buildUpgradeView(status: Omit<UpgradeStatus, "view"> | null): UpgradeView;
export function formatEtaSeconds(seconds: number | null | undefined): string | null;
export function describeDiskShortfall(error: UpgradeStatus["error"]): string | null;
export function diskSentence(disk: string): string;
