function parseStoredValue(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function fallbackId() {
  return `home2-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createH5Port() {
  return {
    target: "h5",

    async request({ url, method = "GET", data, headers = {} }) {
      const response = await fetch(url, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data)
      });

      return {
        ok: response.ok,
        status: response.status,
        data: await response.json()
      };
    },

    storage: {
      get(key, fallback = null) {
        return parseStoredValue(window.localStorage.getItem(key), fallback);
      },
      set(key, value) {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    },

    createId() {
      return globalThis.crypto?.randomUUID?.() || fallbackId();
    },

    fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    },

    canvasToImage(canvas) {
      return canvas.toDataURL("image/png");
    }
  };
}

export function createWechatMiniProgramPort(wx) {
  return {
    target: "wechat-miniprogram",

    request({ url, method = "GET", data, headers = {} }) {
      return new Promise((resolve, reject) => {
        wx.request({
          url,
          method,
          data,
          header: headers,
          success: ({ statusCode, data: payload }) => {
            resolve({
              ok: statusCode >= 200 && statusCode < 300,
              status: statusCode,
              data: payload
            });
          },
          fail: reject
        });
      });
    },

    storage: {
      get(key, fallback = null) {
        return parseStoredValue(wx.getStorageSync(key), fallback);
      },
      set(key, value) {
        wx.setStorageSync(key, JSON.stringify(value));
      }
    },

    createId: fallbackId,

    fileToDataUrl() {
      return Promise.reject(new Error("Use wx.chooseMedia + upload in the mini program port."));
    },

    canvasToImage(canvasId, canvasContext) {
      return new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvasId,
          canvas: canvasContext,
          fileType: "png",
          success: ({ tempFilePath }) => resolve(tempFilePath),
          fail: reject
        });
      });
    }
  };
}

export const runtimePort = createH5Port();
