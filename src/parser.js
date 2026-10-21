/**
 * parser.js —— JD 解析器
 *
 * 目标：把各种来源的 JD（BOSS/智联/猎聘复制、招聘官网、HR 发的文本）统一成结构化对象。
 * 策略：优先用标签正则（准确），失败时用启发式（兜底）。
 */

/** 常见的 JD 字段标签 */
const LABELS = {
  company: ['公司', '公司名称', '企业名称', '招聘企业', '所属公司'],
  position: ['职位', '岗位', '职位名称', '岗位名称', '招聘职位'],
  salary: ['薪资', '月薪', '年薪', '工资', '薪资范围', '待遇'],
  city: ['城市', '工作地点', '地点', '所在城市', '地区', '工作地址'],
  experience: ['经验', '工作经验', '年限', '经验要求'],
  education: ['学历', '学历要求', '最低学历'],
  link: ['链接', '网址', '职位链接', 'URL', 'url'],
};

/** 从「标签：值」格式里抓值 */
function grabLabeled(text, aliases) {
  for (const alias of aliases) {
    // 支持中文冒号、英文冒号、空格分隔，值到行尾
    const re = new RegExp(`${alias}\\s*[:：]\\s*([^\\n\\r]{1,80})`, 'i');
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

/** 薪资：匹配 20-35K / 25k-40k·15薪 / 30万-50万/年 等 */
export function extractSalary(text) {
  const patterns = [
    /\d{1,3}(?:\.\d)?\s*[-~到]\s*\d{1,3}(?:\.\d)?\s*[kK万](?:[·*×x]\s*\d{1,2}\s*薪)?/,
    /\d{1,3}\s*[kK]\s*以上/,
    /\d{1,3}\s*万\s*[-~到]\s*\d{1,3}\s*万(?:\s*\/\s*年)?/,
    /薪资面议|面议/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].replace(/\s+/g, '');
  }
  return '';
}

/** 城市：从常见城市列表里找 */
const CITIES = [
  '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安',
  '苏州', '天津', '重庆', '长沙', '郑州', '青岛', '合肥', '宁波', '厦门',
  '福州', '济南', '大连', '沈阳', '无锡', '东莞', '佛山', '珠海', '远程',
];

export function extractCity(text) {
  const labeled = grabLabeled(text, LABELS.city);
  if (labeled) {
    for (const c of CITIES) if (labeled.includes(c)) return c;
    return labeled.slice(0, 12);
  }
  for (const c of CITIES) if (text.includes(c)) return c;
  return '';
}

/** 经验要求 */
export function extractExperience(text) {
  const labeled = grabLabeled(text, LABELS.experience);
  if (labeled) return labeled;
  const m = text.match(/(\d+\s*[-~到]\s*\d+\s*年|\d+\s*年以上|经验不限|应届)/);
  return m ? m[0].replace(/\s+/g, '') : '';
}

/** 学历 */
export function extractEducation(text) {
  const labeled = grabLabeled(text, LABELS.education);
  if (labeled) return labeled;
  const m = text.match(/(博士|硕士|本科|大专|专科|学历不限)/);
  return m ? m[1] : '';
}

/**
 * 解析一段 JD 文本
 * @param {string} raw 原始文本
 * @param {object} fallback 调用方已知的信息（比如从文件名/表单里带的公司名）
 */
export function parseJD(raw, fallback = {}) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();

  // 职位名：优先标签，其次取第一行（很多 JD 第一行就是职位名）
  let position = grabLabeled(text, LABELS.position);
  if (!position) {
    const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
    // 第一行如果不太长且不含句号，大概率是职位名
    if (firstLine.length <= 30 && !/[。；;]/.test(firstLine)) position = firstLine;
  }

  const company = fallback.company || grabLabeled(text, LABELS.company);
  const link = fallback.link || grabLabeled(text, LABELS.link);

  return {
    id: fallback.id || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    company: company || '未识别公司',
    position: position || '未识别职位',
    salary: extractSalary(text) || '薪资未标注',
    city: extractCity(text) || fallback.city || '',
    experience: extractExperience(text) || '',
    education: extractEducation(text) || '',
    link: link || '',
    text,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 批量解析：按分隔符切分多份 JD
 * 支持分隔符：=== 、--- 、"### "、以及「第 N 个」这类
 */
export function parseBatch(rawBlob, fallback = {}) {
  const text = String(rawBlob || '');
  // 优先用显式分隔符
  let chunks = text.split(/\n\s*(?:={3,}|-{3,}|#{3,})\s*\n/);
  if (chunks.length <= 1) {
    // 退而求其次：按连续空行 + 看起来像新 JD 的行切
    chunks = text.split(/\n{3,}/);
  }
  return chunks
    .map((c) => c.trim())
    .filter((c) => c.length > 40)   // 太短的片段不算一份 JD
    .map((c, i) => parseJD(c, { ...fallback, id: `${fallback.id || 'batch'}_${i}` }));
}
