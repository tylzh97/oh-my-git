// esbuild 以 text loader 打包 .jsonc，导入结果为原文
declare module "*.jsonc" {
  const text: string;
  export default text;
}
