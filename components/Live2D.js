/* eslint-disable no-undef */
import { siteConfig } from '@/lib/config'
import { useGlobal } from '@/lib/global'
import { isMobile, loadExternalResource } from '@/lib/utils'
import { useEffect, useRef } from 'react'

/**
 * moc3 看板娘单例管理器
 *
 * 核心问题：
 * 1. React 18 StrictMode double-mount 导致两次 async init 竞态
 * 2. React 管理的 <canvas> 与 PIXI 争用 WebGL 上下文，destroy 后 canvas 变空白
 * 3. eyeBlink / breath 会触发 updateParameters 崩溃，不能开启
 */
const CANVAS_W = 290
const CANVAS_H = 430

/**
 * 裁切参数：canvas 430px 高，角色只占底部 ~210px，顶部空白会渲染成黑色。
 * 用 overflow:hidden 物理裁掉黑区，再用四边蒙版做柔和淡出。
 */
const CROP_TOP = 225
const VIEW_H = CANVAS_H - CROP_TOP

const FADE_H = 'linear-gradient(to right, transparent 0%, #000 16%, #000 84%, transparent 100%)'
const FADE_V = 'linear-gradient(to bottom, transparent 0%, #000 24%, #000 84%, transparent 100%)'

/** 关闭光环/补框；保留 fw1 粉雾做底部自然过渡 */
const SUPPRESS_GLOW_PARAMS = ['ghfh', 'bk']

let runtimeReady = null
let tickerRegistered = false
let sessionCounter = 0
let destroyTimer = null

let activeSession = 0
let activeApp = null
let activeModel = null
let activeContainer = null
let activePetLink = null
let activeFocusHandler = null
let activeMotionHandler = null
let activeTickerHandler = null
let activeMotionInterval = null

async function ensureMoc3Runtime() {
  if (runtimeReady) {
    return runtimeReady
  }

  runtimeReady = (async () => {
    await loadExternalResource(
      'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
      'js'
    )
    await loadExternalResource(
      'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
      'js'
    )
    await loadExternalResource(
      'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js',
      'js'
    )

    if (!tickerRegistered && window.PIXI?.live2d?.Live2DModel?.registerTicker) {
      window.PIXI.live2d.Live2DModel.registerTicker(window.PIXI.Ticker)
      tickerRegistered = true
    }
  })()

  return runtimeReady
}

function clearMotionLoop() {
  if (activeMotionInterval) {
    clearInterval(activeMotionInterval)
    activeMotionInterval = null
  }

  if (activeModel && activeMotionHandler) {
    activeModel.off('motionFinish', activeMotionHandler)
    activeMotionHandler = null
  }

  if (activeApp && activeTickerHandler) {
    activeApp.ticker.remove(activeTickerHandler)
    activeTickerHandler = null
  }
}

function teardownImmediate() {
  if (activeFocusHandler) {
    window.removeEventListener('mousemove', activeFocusHandler)
    activeFocusHandler = null
  }

  clearMotionLoop()

  activeModel = null
  activeContainer = null
  activePetLink = null

  if (activeApp) {
    activeApp.destroy(true, { children: true, texture: true, baseTexture: true })
    activeApp = null
  }
}

function scheduleTeardown(sessionId) {
  if (destroyTimer) {
    clearTimeout(destroyTimer)
  }
  destroyTimer = setTimeout(() => {
    destroyTimer = null
    if (activeSession === sessionId) {
      teardownImmediate()
    }
  }, 300)
}

/** 隐藏场景框 + 关闭粉雾/光环（不能隐藏 Normal_2 / Part3，会破坏渲染） */
function applyVisualTuning(model) {
  const core = model?.internalModel?.coreModel
  if (!core) {
    return
  }

  try {
    core.setPartOpacityById('Background', 0)
  } catch {
    // ignore
  }

  for (const paramId of SUPPRESS_GLOW_PARAMS) {
    try {
      core.setParameterValueById(paramId, 0)
    } catch {
      // ignore
    }
  }
}

/** 每隔多少毫秒强制切下一个 idle（不依赖 motionFinish，避免动一会就停） */
const MOTION_INTERVAL_MS = 9000

function startIdleLoop(model, sessionId, app) {
  const definitions = model?.internalModel?.motionManager?.definitions
  if (!definitions) {
    return
  }

  const motionGroups = Object.keys(definitions).filter(key =>
    /^(home|main_|idle)/i.test(key)
  )
  if (motionGroups.length === 0) {
    return
  }

  const playNext = () => {
    if (sessionId !== activeSession || activeModel !== model) {
      return
    }

    applyVisualTuning(model)

    const mm = model.internalModel.motionManager
    if (typeof mm.stopAllMotions === 'function') {
      mm.stopAllMotions()
    }

    const group =
      motionGroups[Math.floor(Math.random() * motionGroups.length)] || 'idle'
    const count = definitions[group]?.length || 1
    const index = Math.floor(Math.random() * count)
    model.motion(group, index).catch(() => {})
  }

  activeTickerHandler = () => {
    if (sessionId !== activeSession || activeModel !== model) {
      return
    }
    applyVisualTuning(model)
  }
  app.ticker.add(activeTickerHandler)

  // 主循环：定时强制切换，某些 motion 不会触发 motionFinish 导致卡住
  activeMotionInterval = setInterval(playNext, MOTION_INTERVAL_MS)

  // 若 motion 提前播完，可更早切换（optional 加速）
  activeMotionHandler = () => {
    applyVisualTuning(model)
  }
  model.on('motionFinish', activeMotionHandler)

  playNext()
}

async function mountMoc3Pet(sessionId, container, petLink) {
  if (destroyTimer) {
    clearTimeout(destroyTimer)
    destroyTimer = null
  }

  if (
    activeSession === sessionId &&
    activeContainer === container &&
    activePetLink === petLink &&
    activeApp &&
    activeModel
  ) {
    return
  }

  await ensureMoc3Runtime()
  if (sessionId !== sessionCounter) {
    return
  }

  if (activeApp && activeContainer === container) {
    teardownImmediate()
  }

  const model = await PIXI.live2d.Live2DModel.from(petLink)
  if (sessionId !== sessionCounter) {
    model.destroy()
    return
  }

  const app = new PIXI.Application({
    width: CANVAS_W,
    height: CANVAS_H,
    backgroundAlpha: 0,
    autoStart: true,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2)
  })

  if (sessionId !== sessionCounter) {
    app.destroy(true, { children: true })
    model.destroy()
    return
  }

  const view = app.view
  view.style.width = `${CANVAS_W}px`
  view.style.height = `${CANVAS_H}px`
  view.style.display = 'block'
  view.style.background = 'transparent'
  view.style.outline = 'none'
  view.style.border = 'none'
  view.className = 'cursor-grab bg-transparent'
  view.id = 'live2d-canvas'

  container.replaceChildren(view)

  const scale =
    Math.min(
      CANVAS_W / model.internalModel.width,
      CANVAS_H / model.internalModel.height
    ) * 1.12

  model.scale.set(scale)
  model.anchor.set(0.5, 1)
  model.position.set(CANVAS_W / 2, CANVAS_H - 10)
  app.stage.addChild(model)

  applyVisualTuning(model)

  activeSession = sessionId
  activeApp = app
  activeModel = model
  activeContainer = container
  activePetLink = petLink

  activeFocusHandler = e => model.focus?.(e.clientX, e.clientY)
  window.addEventListener('mousemove', activeFocusHandler, { passive: true })

  startIdleLoop(model, sessionId, app)
}

/**
 * 网页看板娘
 */
export default function Live2D() {
  const { switchTheme } = useGlobal()
  const containerRef = useRef(null)
  const showPet = JSON.parse(siteConfig('WIDGET_PET'))
  const petLink = siteConfig('WIDGET_PET_LINK')
  const petSwitchTheme = siteConfig('WIDGET_PET_SWITCH_THEME')

  useEffect(() => {
    if (!showPet || isMobile()) {
      return
    }

    const container = containerRef.current
    if (!container) {
      return
    }

    const sessionId = ++sessionCounter
    activeSession = sessionId

    if (petLink?.endsWith('.model3.json')) {
      mountMoc3Pet(sessionId, container, petLink).catch(error =>
        console.error('读取PET模型', error)
      )
      return () => scheduleTeardown(sessionId)
    }

    let alive = true
    loadExternalResource(
      'https://cdn.jsdelivr.net/gh/stevenjoezhang/live2d-widget@latest/live2d.min.js',
      'js'
    ).then(() => {
      if (!alive || typeof window?.loadlive2d === 'undefined') {
        return
      }
      try {
        const canvas = document.createElement('canvas')
        canvas.id = 'live2d'
        canvas.width = CANVAS_W
        canvas.height = CANVAS_H
        canvas.className = 'cursor-grab bg-transparent'
        container.replaceChildren(canvas)
        loadlive2d('live2d', petLink)
      } catch (error) {
        console.error('读取PET模型', error)
      }
    })

    return () => {
      alive = false
    }
  }, [showPet, petLink])

  function handleClick() {
    if (petSwitchTheme) {
      switchTheme()
    }
  }

  if (!showPet) {
    return <></>
  }

  return (
    <div
      className='relative z-50 ml-14'
      style={{
        width: CANVAS_W,
        height: VIEW_H,
        overflow: 'hidden',
        WebkitMaskImage: `${FADE_H}, ${FADE_V}`,
        WebkitMaskComposite: 'source-in',
        maskImage: `${FADE_H}, ${FADE_V}`,
        maskComposite: 'intersect'
      }}
      onClick={handleClick}>
      <div
        ref={containerRef}
        className='pointer-events-auto'
        style={{ width: CANVAS_W, height: CANVAS_H, marginTop: -CROP_TOP }}
      />
    </div>
  )
}
