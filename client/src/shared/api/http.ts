import axios from 'axios';

export const TOKEN_KEY = 'yibiao_token';
export const USER_KEY = 'yibiao_user';

const baseURL = import.meta.env.VITE_API_BASE_URL || '/api';

// 公开认证请求不能使用带 401 全局刷新行为的业务客户端。
// 登录、注册和初始密码修改需要将预期的认证错误交给页面自行展示。
export const publicHttp = axios.create({
  baseURL,
  timeout: 30000,
});

// 后端调用收口层：所有 window.yibiao.* 的 Web 替代都走这个 axios 实例。
// baseURL 由 VITE_API_BASE_URL 注入（dev 指向 VM 后端；prod 由 Nginx 反代到 /api）。
export const http = axios.create({
  baseURL,
  timeout: 30000,
});

// 当前活跃项目 id（由 ProjectContext 设置）。注入到 X-Project-Id 头供项目作用域路由消费。
// null = 未选项目（登录后无项目时）；此时不发头，项目作用域路由会 400，由 UI 引导建/选项目。
let activeProjectId: number | null = null;
export function setActiveProjectId(id: number | null): void {
  activeProjectId = id;
}
export function getActiveProjectId(): number | null {
  return activeProjectId;
}

http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (activeProjectId != null) {
    config.headers['X-Project-Id'] = String(activeProjectId);
  }
  return config;
});

http.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error?.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.location.reload();
    }
    return Promise.reject(error);
  }
);
