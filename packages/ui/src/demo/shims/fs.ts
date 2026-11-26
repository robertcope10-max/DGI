// Browser stand-ins: the demo never touches files.
const no = () => { throw new Error('No filesystem in the browser demo'); };
export const readFileSync = no, writeFileSync = no, mkdirSync = no, renameSync = no, appendFileSync = no;
export const existsSync = () => false;
