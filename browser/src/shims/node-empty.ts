/** Stubs for Node modules pulled in by shared code paths the browser never calls (local digest files). */
const notInBrowser = (name: string) => () => { throw new Error(`${name} is not available in the browser`); };
export const existsSync = () => false;
export const readdirSync = notInBrowser("fs.readdirSync");
export const statSync = notInBrowser("fs.statSync");
export const createReadStream = notInBrowser("fs.createReadStream");
export const join = (...parts: string[]) => parts.join("/");
export default {};
