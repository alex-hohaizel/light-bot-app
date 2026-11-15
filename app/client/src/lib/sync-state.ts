let applyingServerData = false;
let lastLocalChangeTs = 0;
const LOCAL_CHANGE_PRIORITY_WINDOW = 2000;

export function isApplyingServerData() {
  return applyingServerData;
}

export function setApplyingServerData(v: boolean) {
  applyingServerData = v;
}

export function getLastLocalChangeTs() {
  return lastLocalChangeTs;
}

export function setLastLocalChangeTs(ts: number) {
  lastLocalChangeTs = ts;
}

export function isRecentLocalChange(): boolean {
  return lastLocalChangeTs > 0 && (Date.now() - lastLocalChangeTs) < LOCAL_CHANGE_PRIORITY_WINDOW;
}
