// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { PrismaClient } from '@prisma/client/edge';
import { withAccelerate } from '@prisma/extension-accelerate';
import type { ExecutionContext } from '@cloudflare/workers-types'; // ExecutionContext をインポート

// Honoアプリの型定義に環境変数を追加
type Bindings = {
  DATABASE_URL_ACCELERATE: string;
  // 他の環境変数があればここに追加
};

// PrismaClientを初期化する関数
function initializePrismaClient(databaseUrl: string) {
  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  }).$extends(withAccelerate());
}

// PrismaClientのインスタンスを格納する変数 (シングルトン)
// 型は初期化関数の戻り値の型から推論させる
let prisma: ReturnType<typeof initializePrismaClient>;

const app = new Hono<{ Bindings: Bindings }>();

// CORS設定 (変更なし)
app.use(
  '/api/*',
  cors({
    origin: ['http://localhost:3000', 'https://YOUR_CLOUDFLARE_PAGES_DOMAIN'],
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    credentials: true,
  })
);
// TODO: 'https://YOUR_CLOUDFLARE_PAGES_DOMAIN' を実際のドメインに置き換える必要があります。

// ヘルスチェックルート
app.get('/', (c) => c.text('Hono Blog Backend (on Cloudflare Workers) is running!'));

// --- ブログ記事関連のAPIエンドポイント ---

// 全ての記事を取得
app.get('/api/posts', async (c) => {
  try {
    const posts = await prisma.post.findMany({
      include: {
        author: {
          select: {
            id: true,
            email: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    return c.json(posts);
  } catch (error) {
    console.error('Error fetching posts:', error);
    return c.json({ error: 'Failed to fetch posts', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// 特定の記事を取得
app.get('/api/posts/:id', async (c) => {
  const { id } = c.req.param();
  try {
    const post = await prisma.post.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    });
    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }
    return c.json(post);
  } catch (error) {
    console.error('Error fetching post:', error);
    return c.json({ error: 'Failed to fetch post', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// 新しい記事を作成
app.post('/api/posts', async (c) => {
  const { title, content, authorId } = await c.req.json();

  if (!title || !content || !authorId) {
    return c.json({ error: 'Title, content, and author ID are required' }, 400);
  }

  try {
    const newPost = await prisma.post.create({
      data: {
        title,
        content,
        authorId,
        published: true,
      },
    });
    return c.json(newPost, 201);
  } catch (error) {
    console.error('Error creating post:', error);
    // エラーオブジェクトの詳細を出力に追加
    if (error instanceof Error) {
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        // console.error('Error stack:', error.stack); // スタックトレースは長くなることがあるので必要に応じて
    } else {
        console.error('Unknown error type:', error);
    }
    return c.json({ error: 'Failed to create post', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// 記事を更新
app.put('/api/posts/:id', async (c) => {
  const { id } = c.req.param();
  const { title, content, published, currentUserId } = await c.req.json();

  if (!currentUserId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  try {
    const existingPost = await prisma.post.findUnique({
      where: { id },
      select: { authorId: true },
    });

    if (!existingPost) {
      return c.json({ error: 'Post not found' }, 404);
    }

    if (existingPost.authorId !== currentUserId) {
      return c.json({ error: 'Unauthorized: You are not the author of this post' }, 403);
    }

    const updatedPost = await prisma.post.update({
      where: { id },
      data: {
        title,
        content,
        published,
      },
    });
    return c.json(updatedPost);
  } catch (error) {
    console.error('Error updating post:', error);
    return c.json({ error: 'Failed to update post', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// 記事を削除
app.delete('/api/posts/:id', async (c) => {
  const { id } = c.req.param();
  const { currentUserId } = await c.req.json();

  if (!currentUserId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  try {
    const existingPost = await prisma.post.findUnique({
      where: { id },
      select: { authorId: true },
    });

    if (!existingPost) {
      return c.json({ error: 'Post not found' }, 404);
    }

    if (existingPost.authorId !== currentUserId) {
      return c.json({ error: 'Unauthorized: You are not the author of this post' }, 403);
    }

    await prisma.post.delete({
      where: { id },
    });
    return c.body(null, 204);
  } catch (error) {
    console.error('Error deleting post:', error);
    return c.json({ error: 'Failed to delete post', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// Cloudflare Workers のエントリーポイント
export default {
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => {
    console.log('DATABASE_URL_ACCELERATE from env:', env.DATABASE_URL_ACCELERATE); // ← これを追加

    if (!prisma) {
      // 値が undefined や空文字列でないか確認
      if (!env.DATABASE_URL_ACCELERATE || typeof env.DATABASE_URL_ACCELERATE !== 'string' || !env.DATABASE_URL_ACCELERATE.startsWith('prisma://')) {
        console.error('Invalid or missing DATABASE_URL_ACCELERATE:', env.DATABASE_URL_ACCELERATE);
        // エラーレスポンスを返すか、適切な処理を行う
        return new Response('Internal Server Error: Database URL misconfiguration', { status: 500 });
      }
      prisma = initializePrismaClient(env.DATABASE_URL_ACCELERATE);
    }
    return app.fetch(request, env, ctx);
  },
};