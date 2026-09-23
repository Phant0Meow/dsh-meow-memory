// 一次性扫描脚本：对 tgz 解包内容或文件列表做敏感信息全量审查（发布红线规程 0mt0frv8c）
// 用法：node _scan-sensitive.cjs <目录>          —— 递归扫目录
//       node _scan-sensitive.cjs --list <清单>  —— 按文件清单扫（相对 cwd）
const fs = require("fs"), path = require("path");
let files = [];
if (process.argv[2] === "--list") {
  files = fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean).map((f) => path.resolve(f));
  var root = process.cwd();
} else {
  var root = process.argv[2];
  (function collect(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) collect(p); else files.push(p);
    }
  })(root);
}
const pats = {
  ipv4: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  tailscale: /ts\.net|tailf|tailnet/gi,
  keys: /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]|gho_[A-Za-z0-9]|github_pat_|Bearer\s+[A-Za-z0-9._-]{10,}|xox[bp]-)/g,
  creds: /(password|passwd|secret|private key)/gi,
  identity: /(Joviel|Hermis)/g,
  winpath: /[A-Z]:\\\\?[A-Za-z]/g,
  unixpath: /(\/Users\/[A-Za-z]|\/home\/[A-Za-z])/g,
  email: /[A-Za-z0-9._%+-]+@[a-z0-9-]+\.(com|net|org|cn)/g,
  nickname: /猫猫/g,
  localhost: /(127\.0\.0\.1|localhost)/g
};
let hits = 0;
for (const p of files) {
  const rel = path.relative(root, p);
  const text = fs.readFileSync(p, "utf8");
  for (const [name, re] of Object.entries(pats)) {
    for (const m of text.matchAll(re)) {
      hits++;
      const line = text.slice(0, m.index).split("\n").length;
      console.log(`[${name}] ${rel}:${line} -> ${JSON.stringify(m[0])}`);
    }
  }
}
console.log(hits === 0 ? "CLEAN: no sensitive hits" : `TOTAL: ${hits} hits`);
