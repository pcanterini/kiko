// No real HID idle time, lock or display: whether someone is at the Mac is T.atComputer (null, as
// when it can't tell, unless a case sets it), and each reading is counted in T.presenceReads.
export async function atComputer() {
  const T = (globalThis as any).T;
  T.presenceReads = (T.presenceReads ?? 0) + 1;
  return T.atComputer ?? null;
}
