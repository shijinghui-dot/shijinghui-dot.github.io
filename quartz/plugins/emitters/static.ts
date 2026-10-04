import { FilePath, QUARTZ, joinSegments } from "../../util/path"
import { QuartzEmitterPlugin } from "../types"
import fs from "fs"
import { glob } from "../../util/glob"
import { dirname, extname } from "path"

// 支持的音频扩展名：构建时扫描 quartz/static/music/ 自动生成播放列表
const AUDIO_EXTENSIONS = [".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav"]

function scanMusicTracks(): string[] {
  const musicPath = joinSegments(QUARTZ, "static", "music")
  try {
    return fs
      .readdirSync(musicPath)
      .filter((f) => AUDIO_EXTENSIONS.includes(extname(f).toLowerCase()))
      .sort()
  } catch {
    return []
  }
}

export const Static: QuartzEmitterPlugin = () => ({
  name: "Static",
  async *emit({ argv, cfg }) {
    const staticPath = joinSegments(QUARTZ, "static")
    const fps = await glob("**", staticPath, cfg.configuration.ignorePatterns)
    const outputStaticPath = joinSegments(argv.output, "static")
    await fs.promises.mkdir(outputStaticPath, { recursive: true })
    for (const fp of fps) {
      const src = joinSegments(staticPath, fp) as FilePath
      const dest = joinSegments(outputStaticPath, fp) as FilePath
      await fs.promises.mkdir(dirname(dest), { recursive: true })
      await fs.promises.copyFile(src, dest)
      yield dest
    }

    // 生成背景音乐播放列表，供 bgm.inline.ts 在浏览器端读取
    const manifestDest = joinSegments(outputStaticPath, "music", "manifest.json") as FilePath
    await fs.promises.mkdir(dirname(manifestDest), { recursive: true })
    await fs.promises.writeFile(manifestDest, JSON.stringify(scanMusicTracks()))
    yield manifestDest
  },
  async *partialEmit() {},
})
