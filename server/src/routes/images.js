import express from 'express'
import multer from 'multer'
import path from 'path'
import sharp from 'sharp'
import { User } from '../models/User.js'
import { auth } from '../middleware/auth.js'
import { Image } from '../models/Image.js'
import { Config } from '../models/Config.js'
import { UploadLog } from '../models/UploadLog.js'
import { checkDailyLimit } from '../middleware/checkDailyLimit.js'
import { checkIpWhitelist } from '../middleware/checkIpWhitelist.js'
import {
  uploadToOSS, uploadToCOS, uploadToS3,
  uploadToR2, getUploadToken, uploadToQiNiu,
  uploadToUpyun, uploadToSftp, uploadToFtp,
  uploadToWebdav, uploadToTelegram, uploadToGithub
} from '../utils/oss.js'
import fs from 'fs/promises'
import crypto from 'crypto'
import { createReadStream } from 'fs'
import {
  tencentCheckImageSecurity,
  aliyunCheckImageSecurity,
  nsfwjsCheckImageSecurity
} from '../utils/security.js'

const router = express.Router()

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads')
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname))
  }
})

const upload = multer({
  storage, fileFilter: async (req, file, cb) => {
    try {
      const { upload } = await Config.findOne()
      const ext = path.extname(file.originalname).toLowerCase().slice(1)
      if (!upload.allowedFormats.includes(ext)) {
        return cb(new Error('不支持的图片格式'))
      }
      cb(null, true)
    } catch (error) {
      cb(error)
    }
  }
})

// 计算MD5
const calculateMD5 = async (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      hash.update(chunk)
    })
    stream.on('end', () => {
      resolve(hash.digest('hex'))
    })
    stream.on('error', (err) => {
      reject(err)
    })
  })
}

// 创建目录
const checkAndCreateDir = async (dirPath) => {
  try {
    await fs.access(dirPath)
  } catch (error) {
    try {
      await fs.mkdir(dirPath, { recursive: true })
    } catch (mkdirError) {
      throw mkdirError
    }
  }
}

// 修改计算 SHA-1 的函数
const calculateSHA1 = async (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = createReadStream(filePath)
    stream.on('error', err => reject(err))
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

// 图片广场
router.post('/images', async (req, res) => {
  try {
    const { site } = await Config.findOne()
    if (!site.gallery) {
      res.status(500).json({ error: '图片广场功能未开启' })
      return
    }
    const { page, limit } = req.body
    const token = req.header('Authorization')?.replace('Bearer ', '')
    // 确保页码和每页数量为有效数字
    const pageMath = Math.max(1, parseInt(page))
    const limitMath = Math.max(1, parseInt(limit))
    // 计算跳过的记录数
    const skip = (pageMath - 1) * limitMath
    // 创建基础查询
    let query = Image.find()
      .select(!token ? 'url thumb type' : '')
      .sort({ date: -1 })
      .skip(skip)
      .limit(limitMath)
    // 只在有 token 时执行 populate
    if (token) {
      query = query.populate('user', 'username')
    }
    // 获取总数
    const total = await Image.countDocuments()
    res.json({
      images: await query,
      total
    })
  } catch ({ message }) {
    res.status(500).json({ error: message })
  }
})

// 添加文件命名规则处理函数
const generateFileName = async (file, req, isuser) => {
  const { upload } = await Config.findOne()
  // 获取文件信息
  const ext = path.extname(file.originalname).toLowerCase().slice(1)
  const filename = path.basename(file.originalname, path.extname(file.originalname))
  const time = Date.now()
  const uniqid = time.toString(36) + Math.random().toString(36).slice(2)
  const md5 = req.body.md5
  const sha1 = await calculateSHA1(file.path)
  const uuid = crypto.randomUUID()
  const uid = isuser ? req.user._id : 'guest'
  // 获取日期信息
  const date = new Date()
  const Y = date.getFullYear()
  const y = Y.toString().slice(2)
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const Ymd = `${Y}${m}${d}`
  // 替换变量
  return upload.namingRule
    .replace(/{Y}/g, Y)
    .replace(/{y}/g, y)
    .replace(/{m}/g, m)
    .replace(/{d}/g, d)
    .replace(/{Ymd}/g, Ymd)
    .replace(/{filename}/g, filename)
    .replace(/{ext}/g, upload.convertFormat || ext)
    .replace(/{time}/g, time)
    .replace(/{uniqid}/g, uniqid)
    .replace(/{md5}/g, md5)
    .replace(/{sha1}/g, sha1)
    .replace(/{uuid}/g, uuid)
    .replace(/{uid}/g, uid)
}

// 上传图片相关函数
const uploadImageToStorage = async (file, req, isuser) => {
  const md5 = await calculateMD5(file.path)
  try {
    const { site, upload, storage, watermark, ai } = await Config.findOne()
    const reqBodyIp = req.body.ip.includes('127.0.0.1') || !req.body.ip ? req.ip : req.body.ip
    const reqIp = req.ip.includes('::1') || req.ip.includes('127.0.0.1') || !req.ip ? reqBodyIp : req.ip
    const bodyIp = reqIp || reqBodyIp
    // 检查有没有填写网站URL
    if (!site.url) {
      throw new Error('请先配置网站URL')
    }
    // 检查文件大小
    if (file.size > upload.maxSize * 1024 * 1024) {
      throw new Error(`文件大小不能超过 ${upload.maxSize}MB`)
    }
    // 获取图片信息
    const { format, width, height } = await sharp(file.path).metadata()
    // 检查图片格式
    if (!upload.allowedFormats.includes(format)) {
      throw new Error('不支持的图片格式')
    }
    // 检查图片尺寸
    if (upload.minWidth && width < upload.minWidth) {
      throw new Error(`图片宽度不能小于 ${upload.minWidth}px`)
    }
    if (upload.minHeight && height < upload.minHeight) {
      throw new Error(`图片高度不能小于 ${upload.minHeight}px`)
    }
    // 查找已存在的图片
    const existingImage = await Image.findOne({ md5 })
    if (existingImage) {
      // 删除上传的图片
      await fs.unlink(file.path)
      // 返回已上传图片的信息
      return existingImage.toObject()
    }
    let securityResult, labelResults
    // 如果启用了内容安全检测
    if (ai.enabled) {
      // 先上传到临时位置
      const tempPath = path.join('uploads', 'temp', `${Date.now()}.${path.extname(file.originalname)}`)
      await fs.mkdir(path.dirname(tempPath), { recursive: true })
      await fs.copyFile(file.path, tempPath)
      switch (ai.type) {
        case 'tencent':
          try {
            if (file.size >= 10 * 1024 * 1024) {
              throw new Error('图片大小超过腾讯云图片审查服务最大图片10MB限制')
            }
            // 进行内容安全检测
            const tencent = await tencentCheckImageSecurity(tempPath)
            securityResult = tencent.safe
            labelResults = tencent.Label
            // 删除临时文件
            await fs.unlink(tempPath)
            if (ai.action === 'mark' && tencent.safe === 'Block') {
              throw new Error('图片中包含敏感内容, 已被删除')
            }
  } catch (error) {
            throw error
          }
          break
        case 'aliyun':
          try {
            if (file.size >= 20 * 1024 * 1024) {
              throw new Error('图片大小超过阿里云图片审查服务最大图片20MB限制')
            }
      // 检查图片尺寸
            if (width >= 30000 || height >= 30000) {
              throw new Error('图片高宽超过阿里云图片审查服务最大高宽30000px限制')
            }
            // 进行内容安全检测
            const aliyun = await aliyunCheckImageSecurity(tempPath)
            securityResult = aliyun.safe
            labelResults = aliyun.label
            // 删除临时文件
            await fs.unlink(tempPath)
            if (ai.action === 'mark' && aliyun.safe === 'high') {
              throw new Error('图片中包含敏感内容, 已被删除')
            }
          } catch (error) {
            throw error
          }
          break
        case 'nsfwjs':
          try {
            // 进行内容安全检测
            const nsfwjs = await nsfwjsCheckImageSecurity(tempPath)
            securityResult = nsfwjs.safe
            labelResults = nsfwjs.label
            // 删除临时文件
            await fs.unlink(tempPath)
            if (ai.action === 'mark' && nsfwjs.safe === 'Block') {
              throw new Error('图片中包含敏感内容, 已被删除')
            }
          } catch (error) {
            throw error
          }
          break
        default:
          throw new Error('未知的安全检测类型')
      }
      }
      // 处理图片
      let imageProcessor = sharp(file.path)
    // 生成缩略图
    const thumbnailPath = path.join('uploads', storage.local.path, 'thumbnails')
    await checkAndCreateDir(thumbnailPath)
    const thumbnailFilename = `thumb_${Date.now()}.${upload.convertFormat || format}`
    const thumbnailFullPath = path.join(thumbnailPath, thumbnailFilename)
    // 生成缩略图（这里设置缩略图尺寸为 200x200，保持比例）
    await imageProcessor.clone().resize({
      width: Math.round(width * 0.5),
      height: Math.round(height * 0.5),
      fit: 'inside',
      withoutEnlargement: true
    }).toFile(thumbnailFullPath)
      // 调整尺寸
    if (upload.maxWidth || upload.maxHeight) {
        imageProcessor = imageProcessor.resize({
        width: upload.maxWidth || undefined,
        height: upload.maxHeight || undefined,
          fit: 'inside'
        })
      }
    // 转换格式
    if (upload.convertFormat) {
      switch (upload.convertFormat.toLowerCase()) {
          case 'jpeg':
          case 'jpg':
          imageProcessor = imageProcessor.jpeg()
            break
          case 'png':
          imageProcessor = imageProcessor.png()
            break
          case 'webp':
          // 检查是否为 GIF 动画
          const metadata = await imageProcessor.metadata()
          if (metadata.pages && metadata.pages > 1) {
            // 如果是多帧 GIF，使用 toFormat 方法
            imageProcessor = imageProcessor.toFormat('webp', {
              animated: true,
              effort: 6
            })
          } else {
            // 单帧图片
            imageProcessor = imageProcessor.webp()
          }
            break
          case 'gif':
            imageProcessor = imageProcessor.gif()
            break
          default:
          imageProcessor = imageProcessor.jpeg()
      }
        }
    if (upload.qualityOpen) {
        // 如果没有指定格式转换，但指定了质量，则使用原始格式
        switch (format) {
          case 'jpeg':
          case 'jpg':
            imageProcessor = imageProcessor.jpeg({
            quality: upload.quality
            })
            break
          case 'png':
            imageProcessor = imageProcessor.png({
            quality: upload.quality
            })
            break
          case 'webp':
            imageProcessor = imageProcessor.webp({
            quality: upload.quality
            })
            break
        }
      }
      // 添加水印
    if (watermark.enabled) {
      if (watermark.type === 'text' && watermark.text.content) {
          // 添加文字水印
        const { content, fontSize, color, position } = watermark.text
          // 创建文字水印
          const svgText = `
            <svg width="100%" height="100%">
              <style>
                .watermark {
                  font-size: ${fontSize}px;
                  fill: ${color};
                  font-family: Arial, sans-serif;
                }
              </style>
              <text class="watermark" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">
                ${content}
              </text>
            </svg>
          `
          // 根据位置计算偏移
          let gravity
          switch (position) {
            case 'top-left':
              gravity = 'northwest'
              break
            case 'top-right':
              gravity = 'northeast'
              break
            case 'bottom-left':
              gravity = 'southwest'
              break
            case 'bottom-right':
              gravity = 'southeast'
              break
            case 'center':
              gravity = 'center'
              break
            default:
              gravity = 'southeast'
          }
          // 添加文字水印
          imageProcessor = imageProcessor.composite([{
            input: Buffer.from(svgText),
            gravity,
            top: 10,
            left: 10
          }])
      } else if (watermark.type === 'image' && watermark.image.path) {
          // 添加图片水印
        const { path: watermarkPath, opacity, position } = watermark.image
          // 读取水印图片
          const watermarkBuffer = await sharp(path.join(process.cwd(), watermarkPath))
            .resize(200) // 调整水印大小
            .toBuffer()
          // 根据位置计算偏移
          let gravity
          switch (position) {
            case 'top-left':
              gravity = 'northwest'
              break
            case 'top-right':
              gravity = 'northeast'
              break
            case 'bottom-left':
              gravity = 'southwest'
              break
            case 'bottom-right':
              gravity = 'southeast'
              break
            case 'center':
              gravity = 'center'
              break
            default:
              gravity = 'southeast'
          }
          // 添加图片水印
          imageProcessor = imageProcessor.composite([{
            input: watermarkBuffer,
            gravity,
            top: 10,
            left: 10,
            blend: 'over'
          }])
        }
      }
      // 保存处理后的图片
    const uploadPath = 'uploads' + storage.local.path
    checkAndCreateDir(uploadPath)
    // 生成文件名
    const processedFilename = await generateFileName(file, req, isuser)
    const processedPath = path.join(uploadPath, processedFilename)
    // 确保目录存在
    await checkAndCreateDir(path.dirname(processedPath))
      await imageProcessor.toFile(processedPath)
    // 获取处理后的文件大小
    const processedStats = await fs.stat(processedPath)
    const processedSize = processedStats.size
    // 计算处理后的图片的 SHA-1 值
    const sha1 = await calculateSHA1(processedPath)
    let url = '', filePath = ''
    switch (storage.type) {
      case 'local':
        url = `/${uploadPath}${processedFilename}`
        filePath = url
        break
      case 'oss':
        // 上传到OSS
        const ossPath = `${storage.oss.path}${processedFilename}`
        filePath = ossPath
        // 上传到OSS后删除本地文件 
        try {
          url = await uploadToOSS(processedPath, ossPath)
        } catch ({ message }) {
          throw new Error('上传到OSS失败: ' + message)
        }
        break
      case 'cos':
        // 上传到COS
        const cosPath = `${storage.cos.filePath}/${processedFilename}`
        filePath = cosPath
        try {
          url = await uploadToCOS(processedPath, cosPath, processedFilename)
        } catch ({ message }) {
          throw new Error('上传到COS失败: ' + message)
        }
        break
      case 's3':
        // 上传到S3
        filePath = `${storage.s3.directory}/${processedFilename}`
        try {
          url = await uploadToS3(`${uploadPath}${processedFilename}`)
        } catch ({ message }) {
          throw new Error('上传到S3失败: ' + message)
        }
        break
      case 'r2':
        // 上传到R2
        filePath = `${storage.r2.directory}/${processedFilename}`
        try {
          url = await uploadToR2(`${uploadPath}${processedFilename}`)
        } catch (error) {
          throw new Error('R2上传失败:', error)
        }
        break
      case 'qiniu':
        // 上传到七牛
        filePath = `/${processedFilename}`
        try {
          // 获取上传凭证
          const token = await getUploadToken()
          // 上传到七牛
          const urlInfo = await uploadToQiNiu(token, processedPath, processedFilename)
          if (urlInfo) {
            url = urlInfo
          }
        } catch (error) {
          throw new Error('七牛上传失败:', error)
        }
        break
      case 'upyun':
        // 上传到七牛
        filePath = `${storage.upyun.directory}/${processedFilename}`
        try {
          const urlInfo = await uploadToUpyun(processedPath)
          if (urlInfo) {
            url = urlInfo
          }
        } catch (error) {
          throw new Error('又拍云上传失败:', error)
        }
        break
      case 'sftp':
        // 上传到SFTP
        filePath = `${storage.sftp.directory}/${processedFilename}`
        try {
          const urlInfo = await uploadToSftp(processedPath, processedFilename)
          if (urlInfo) {
            url = urlInfo
          }
        } catch (error) {
          throw new Error('SFTP上传失败:', error)
        }
        break
      case 'ftp':
        // 上传到FTP
        filePath = `${storage.ftp.directory}/${processedFilename}`
        try {
          const urlInfo = await uploadToFtp(processedPath, processedFilename)
          if (urlInfo) {
            url = urlInfo
          }
        } catch (error) {
          throw new Error('FTP上传失败:', error)
        }
        break
      case 'webdav':
        // 上传到WEBDAV
        filePath = `${storage.webdav.directory}/${processedFilename}`
        try {
          const urlInfo = await uploadToWebdav(processedPath, processedFilename)
          if (urlInfo) {
            url = urlInfo
          }
        } catch (error) {
          throw new Error('WebDAV上传失败:', error)
        }
        break
      case 'telegram':
        try {
          const urlInfo = await uploadToTelegram(processedPath, processedFilename, req.user)
          if (urlInfo) {
            url = urlInfo.url
            filePath = urlInfo.fileId
          }
        } catch (error) {
          throw new Error('Telegram上传失败:', error)
        }
        break
      case 'github':
        filePath = `${storage.github.directory}/${processedFilename}`
        try {
          const urlInfo = await uploadToGithub(processedPath, processedFilename, req.user)
          if (urlInfo) {
            url = urlInfo
          }
        } catch (error) {
          throw new Error('Github上传失败:', error)
        }
        break
      default:
        throw new Error('未知的存储类型')
    }
    // 清理本地未处理的图片源文件
    try {
      // 等待一小段时间确保文件不再被使用
      await new Promise(resolve => setTimeout(resolve, 100))
        await fs.unlink(file.path)
    } catch (unlinkError) {
      console.error('删除临时文件失败:', unlinkError)
    }
    // 缩略图路径
    const thumb = `/${uploadPath}thumbnails/${thumbnailFilename}`
    // 保存图片记录，添加 SHA-1 值
      const image = new Image({
        name: file.originalname,
      url,
      thumb,
      md5,
      sha1,
      safe: securityResult,
      label: labelResults,
      type: storage.type,
      user: isuser ? req.user._id : null,
      width,
      height,
        date: Date.now(),
      ip: bodyIp,
      size: processedSize,
      filePath,
      filename: processedFilename,
    })
    // 保存图片信息
      await image.save()
    // 上传日志也添加 SHA-1 值
      const log = new UploadLog({
      user: isuser ? req.user._id : null,
      ip: bodyIp,
        image: image._id,
        originalName: file.originalname,
      size: processedSize,
      format,
      md5,
      width,
      height,
      sha1,
      filename: processedFilename,
      })
      await log.save()
    return image
  } catch ({ message }) {
    try {
      // 等待一小段时间确保文件不再被使用
      await new Promise(resolve => setTimeout(resolve, 100))
      await fs.unlink(file.path)
        } catch (unlinkError) {
      console.error('删除临时文件失败:', unlinkError)
    }
    throw new Error(message)
  }
}

// 用户上传
router.post('/upload', auth, upload.single('image'), checkIpWhitelist, checkDailyLimit, async (req, res) => {
  try {
    const image = await uploadImageToStorage(req.file, req, true)
    res.status(201).json(image)
  } catch ({ message }) {
    if (message.includes('图片中包含敏感内容, 已被删除')) {
      const { ip, ai } = await Config.findOne()
      const reqBodyIp = req.body.ip.includes('127.0.0.1') || !req.body.ip ? req.ip : req.body.ip
      const reqIp = req.ip.includes('::1') || req.ip.includes('127.0.0.1') || !req.ip ? reqBodyIp : req.ip
      const bodyIp = reqIp || reqBodyIp
      if (ai.autoBlack && ip.enabled && ip.blacklist.indexOf(bodyIp) === -1) {
        ip.blacklist.push(bodyIp)
        await Config.findOneAndUpdate({}, { $set: { ip } }, { new: true, upsert: true })
        return res.status(400).json({ error: '当前上传IP已被拉黑' })
      }
    }
    return res.status(400).json({ error: message })
  }
})

// 游客上传
router.post('/tourist/upload', upload.single('image'), checkIpWhitelist, checkDailyLimit, async (req, res) => {
  try {
    const image = await uploadImageToStorage(req.file, req, false)
    res.status(201).json(image)
  } catch ({ message }) {
    if (message.includes('图片中包含敏感内容, 已被删除')) {
      const { ip, ai } = await Config.findOne()
      const reqBodyIp = req.body.ip.includes('127.0.0.1') || !req.body.ip ? req.ip : req.body.ip
      const reqIp = req.ip.includes('::1') || req.ip.includes('127.0.0.1') || !req.ip ? reqBodyIp : req.ip
      const bodyIp = reqIp || reqBodyIp
      if (ai.autoBlack && ip.enabled && ip.blacklist.indexOf(bodyIp) === -1) {
        ip.blacklist.push(bodyIp)
        await Config.findOneAndUpdate({}, { $set: { ip } }, { new: true, upsert: true })
        return res.status(400).json({ error: '当前上传IP已被拉黑' })
      }
    }
    return res.status(400).json({ error: message })
  }
})

// 上传用户头像
router.post('/upload-avatar', auth, upload.single('image'), async (req, res) => {
  const { file, user } = req
  try {
    const { site, upload } = await Config.findOne()
    // 检查有没有填写网站URL
    if (!site.url) {
      throw new Error('请先配置网站URL')
    }
    if (!file) {
      return res.status(400).json({ error: '请选择要上传的图片' })
    }
    if (file.size > upload.maxSize * 1024 * 1024) {
      throw new Error(`文件大小不能超过 ${upload.maxSize}MB`)
    }
    // 获取图片信息
    const { format, width, height } = await sharp(file.path).metadata()
    // 检查图片格式
    if (!upload.allowedFormats.includes(format)) {
      throw new Error('不支持的图片格式')
    }
    // 检查图片尺寸
    if (upload.minWidth && width < upload.minWidth) {
      throw new Error(`图片宽度不能小于 ${upload.minWidth}px`)
    }
    if (upload.minHeight && height < upload.minHeight) {
      throw new Error(`图片高度不能小于 ${upload.minHeight}px`)
    }
    // 处理头像图片
    const imageProcessor = sharp(file.path)
      .resize(100, 100, {
        fit: 'cover',
        position: 'center'
      }).webp({ quality: 80 })
    // 生成文件名
    const filename = `avatar_${user._id}_${Date.now()}.webp`
    const uploadPath = 'uploads/avatars'
    await checkAndCreateDir(uploadPath)
    const filePath = path.join(uploadPath, filename)
    // 保存处理后的图片
    await imageProcessor.toFile(filePath)
    const url = `/${uploadPath}/${filename}`
    // 更新用户头像
    const userinfo = await User.findById(user._id)
    userinfo.avatar = url
    await userinfo.save()
    if (user.avatar) {
      const name = user.avatar.replace(`${uploadPath}/`, '')
      // 删除旧的头像
      await fs.unlink(path.join(uploadPath, name))
    }
    // 清理临时文件
    await fs.unlink(file.path)
    res.json({ message: user.avatar ? '头像上传成功, 旧头像已删除' : '头像上传成功', avatar: url })
  } catch ({ message }) {
    await fs.unlink(file.path)
    res.status(400).json({ error: message })
  }
})

export default router