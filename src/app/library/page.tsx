import { redirect } from 'next/navigation';

/** 图库已并入空间：旧 /library 链接一律跳转到空间列表 */
export default function LibraryRedirectPage() {
  redirect('/spaces');
}
