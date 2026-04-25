import { appendFileSync, createReadStream, mkdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import COS from 'cos-nodejs-sdk-v5'
import nodemailer from 'nodemailer'

/**
 * 脚本所在目录
 *
 * @type {string}
 */
const scriptDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 项目根目录
 *
 * @type {string}
 */
const repoRoot = path.resolve(scriptDir, '..')

/**
 * 本地环境变量文件
 *
 * @type {string}
 */
const envFile = path.join(repoRoot, '.env')

/**
 * 日志目录
 *
 * @type {string}
 */
const logDir = path.join(repoRoot, 'logs')

/**
 * 日志文件
 *
 * @type {string}
 */
const logFile = path.join(logDir, 'update-iptv.log')

/**
 * 必需的环境变量名
 *
 * @type {string[]}
 */
const requiredEnv = [
  'IPTV_LINK',
  'COS_SECRET_ID',
  'COS_SECRET_KEY',
  'COS_BUCKET',
  'COS_REGION',
]

/**
 * 邮件提醒必需的环境变量名
 *
 * @type {string[]}
 */
const emailRequiredEnv = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'MAIL_TO',
]

/**
 * 默认邮件主题前缀
 *
 * @type {string}
 */
const DEFAULT_MAIL_SUBJECT_PREFIX = 'IPTV 更新失败'

/**
 * 本地文件路径
 *
 * @type {{fixed: string, iptv: string, iptv2: string}}
 */
const files = {
  fixed: path.join(repoRoot, 'fixedtv.m3u'),
  iptv: path.join(repoRoot, 'iptv.m3u'),
  iptv2: path.join(repoRoot, 'iptv2.m3u'),
}

/**
 * 腾讯 COS 客户端实例
 *
 * @type {COS | undefined}
 */
let cos

/**
 * 执行完整更新流程
 *
 * @returns {Promise<void>}
 */
async function main() {
  loadLocalEnvFile()
  validateRequiredEnv()

  await mkdir(repoRoot, { recursive: true })
  await removeGeneratedFiles()

  log(`Node version: ${process.version}`)
  log(`Downloading iptv2.m3u from ${getUrlOrigin(process.env.IPTV_LINK)}`)
  /**
   * 下载得到的 IPTV 内容
   *
   * @type {string}
   */
  const iptv2Content = await downloadText(process.env.IPTV_LINK)
  validateIptvContent(iptv2Content)

  log('Creating iptv.m3u')
  /**
   * 本地固定频道内容
   *
   * @type {string}
   */
  const fixedContent = await readFile(files.fixed, 'utf8')

  /**
   * 合并后的 IPTV 内容
   *
   * @type {string}
   */
  const iptvContent = mergeIptvContent(iptv2Content, fixedContent)

  await writeFile(files.iptv2, iptv2Content, 'utf8')
  await writeFile(files.iptv, iptvContent, 'utf8')

  try {
    log('Uploading iptv.m3u to Tencent COS')
    await uploadToCos(files.iptv, 'iptv.m3u')

    log('Uploading iptv2.m3u to Tencent COS')
    await uploadToCos(files.iptv2, 'iptv2.m3u')

    log('Files uploaded to Tencent COS successfully')
  } finally {
    await removeGeneratedFiles()
  }
}

/**
 * 是否启用邮件提醒
 *
 * @returns {boolean} 是否启用
 */
function isEmailNotifyEnabled() {
  return process.env.EMAIL_NOTIFY === 'true'
}

/**
 * 校验邮件提醒环境变量
 *
 * @returns {void}
 */
function validateEmailEnv() {
  if (!isEmailNotifyEnabled()) {
    return
  }

  /**
   * 缺失的邮件环境变量名
   *
   * @type {string[]}
   */
  const missingEnv = emailRequiredEnv.filter((name) => !process.env[name])
  if (missingEnv.length > 0) {
    throw new Error(
      `Missing required email environment variables: ${missingEnv.join(', ')}`,
    )
  }
}

/**
 * 校验必需环境变量
 *
 * @returns {void}
 */
function validateRequiredEnv() {
  /**
   * 缺失的环境变量名
   *
   * @type {string[]}
   */
  const missingEnv = requiredEnv.filter((name) => !process.env[name])
  if (missingEnv.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingEnv.join(', ')}`,
    )
  }

  validateEmailEnv()
}

/**
 * 加载本地 .env 文件
 *
 * @returns {void}
 */
function loadLocalEnvFile() {
  try {
    loadEnvFile(envFile)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
}

/**
 * 获取腾讯 COS 客户端
 *
 * @returns {COS} COS 客户端
 */
function getCosClient() {
  if (!cos) {
    cos = new COS({
      SecretId: process.env.COS_SECRET_ID,
      SecretKey: process.env.COS_SECRET_KEY,
    })
  }

  return cos
}

/**
 * 下载文本内容
 *
 * @param {string} url - 下载地址
 * @returns {Promise<string>} 文本内容
 */
async function downloadText(url) {
  /**
   * 下载接口响应
   *
   * @type {Response}
   */
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(
      `Download failed with HTTP ${response.status} ${response.statusText}`,
    )
  }

  return response.text()
}

/**
 * 校验 IPTV 内容
 *
 * @param {string} content - IPTV 内容
 * @returns {void}
 */
function validateIptvContent(content) {
  if (content.includes('未验证通过')) {
    throw new Error('IPTV file invalid: verification failed')
  }

  if (content.includes('请求过于频繁')) {
    throw new Error('IPTV file invalid: request too frequent')
  }
}

/**
 * 合并 IPTV 和固定频道内容
 *
 * @param {string} iptv2Content - 下载的 IPTV 内容
 * @param {string} fixedContent - 固定频道内容
 * @returns {string} 合并后的 IPTV 内容
 */
function mergeIptvContent(iptv2Content, fixedContent) {
  /**
   * 下载内容的行列表
   *
   * @type {string[]}
   */
  const iptv2Lines = normalizeNewlines(iptv2Content).split('\n')
  if (!iptv2Lines[0]?.trim()) {
    throw new Error('iptv2.m3u is empty or missing the header line')
  }

  /**
   * 去除尾部空行后的固定频道内容
   *
   * @type {string}
   */
  const fixed = normalizeNewlines(fixedContent).replace(/\n+$/u, '')

  /**
   * 合并后的行列表
   *
   * @type {string[]}
   */
  const mergedLines = [iptv2Lines[0], fixed, ...iptv2Lines.slice(1)]

  return `${mergedLines.join('\n').replace(/\n+$/u, '')}\n`
}

/**
 * 统一换行符为 LF
 *
 * @param {string} content - 原始内容
 * @returns {string} 处理后的内容
 */
function normalizeNewlines(content) {
  return content.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
}

/**
 * 获取 URL 来源，避免日志记录完整链接
 *
 * @param {string} url - 原始 URL
 * @returns {string} URL 来源
 */
function getUrlOrigin(url) {
  try {
    return new URL(url).origin
  } catch {
    return 'invalid URL'
  }
}

/**
 * 上传文件到腾讯 COS
 *
 * @param {string} filePath - 本地文件路径
 * @param {string} key - COS 对象键
 * @returns {Promise<unknown>} COS 响应
 */
function uploadToCos(filePath, key) {
  return new Promise((resolve, reject) => {
    getCosClient().putObject(
      {
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Key: key,
        Body: createReadStream(filePath),
      },
      (error, data) => {
        if (error) {
          reject(error)
          return
        }

        resolve(data)
      },
    )
  })
}

/**
 * 删除生成的 IPTV 文件
 *
 * @returns {Promise<void>}
 */
async function removeGeneratedFiles() {
  await Promise.all([
    rm(files.iptv, { force: true }),
    rm(files.iptv2, { force: true }),
  ])
}

/**
 * 输出带时间戳的日志
 *
 * @param {string} message - 日志内容
 * @returns {void}
 */
function log(message) {
  const line = `[${formatLocalTime(new Date())}] INFO ${message}`
  console.log(line)
  writeLogLine(line)
}

/**
 * 输出错误日志
 *
 * @param {unknown} error - 错误对象
 * @returns {void}
 */
function logError(error) {
  const message = formatError(error)
  const line = `[${formatLocalTime(new Date())}] ERROR ${message}`
  console.error(line)
  writeLogLine(line)
}

/**
 * 发送错误提醒邮件
 *
 * @param {unknown} error - 错误对象
 * @returns {Promise<void>}
 */
async function sendErrorEmail(error) {
  if (!isEmailNotifyEnabled()) {
    return
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })

  const message = formatError(error)
  const now = new Date()

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.MAIL_TO,
    subject: buildErrorMailSubject(now),
    text: buildErrorMailText(message, now),
  })

  log('错误提醒邮件已发送')
}

/**
 * 构造错误提醒邮件主题
 *
 * @param {Date} date - 发送时间
 * @returns {string} 邮件主题
 */
function buildErrorMailSubject(date) {
  return `[IPTV] ${DEFAULT_MAIL_SUBJECT_PREFIX} at ${formatLocalTime(date)}`
}

/**
 * 构造错误提醒邮件正文
 *
 * @param {string} message - 格式化后的错误内容
 * @param {Date} date - 发送时间
 * @returns {string} 邮件正文
 */
function buildErrorMailText(message, date) {
  return [
    'IPTV 自动更新失败。',
    '',
    `时间: ${formatLocalTime(date)}`,
    `项目目录: ${repoRoot}`,
    `Node: ${process.version}`,
    '',
    '错误详情:',
    message,
  ].join('\n')
}

/**
 * 格式化本地时间
 *
 * @param {Date} date - 时间对象
 * @returns {string} 本地时间
 */
function formatLocalTime(date) {
  const pad = (value, length = 2) => String(value).padStart(length, '0')

  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
  ].join('')
}

/**
 * 格式化错误及底层原因
 *
 * @param {unknown} error - 错误对象
 * @returns {string} 错误信息
 */
function formatError(error) {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const parts = [error.stack || error.message]

  /**
   * 底层错误原因
   *
   * @type {unknown}
   */
  const cause = error.cause
  if (cause instanceof Error) {
    parts.push(`Caused by: ${cause.stack || cause.message}`)
  } else if (cause) {
    parts.push(`Caused by: ${String(cause)}`)
  }

  return parts.join('\n')
}

/**
 * 写入日志文件
 *
 * @param {string} line - 日志行
 * @returns {void}
 */
function writeLogLine(line) {
  try {
    mkdirSync(logDir, { recursive: true })
    appendFileSync(logFile, `${line}\n`, 'utf8')
  } catch (error) {
    console.error('Failed to write log file:', error)
  }
}

/**
 * 处理致命错误
 *
 * @param {unknown} error - 错误对象
 * @returns {Promise<void>}
 */
async function handleFatalError(error) {
  await removeGeneratedFiles()
  logError(error)

  try {
    await sendErrorEmail(error)
  } catch (emailError) {
    logError(emailError)
  }

  process.exitCode = 1
}

main().catch(handleFatalError)
