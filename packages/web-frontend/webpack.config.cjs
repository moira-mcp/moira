const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const { DefinePlugin } = require("webpack");

// Load environment variables from .env file
// In Docker: .env is in /app (root), in local dev: .env.local in project root
const envFileSuffix = process.env.NODE_ENV === "development" ? ".local" : "";
const projectRoot = path.resolve(__dirname, "../..");
const envPath = path.resolve(projectRoot, `.env${envFileSuffix}`);
require("dotenv").config({ path: envPath });

// Get MCP URL from environment (used in QuickStartCard)
function getMcpUrl() {
  const host = process.env.MOIRA_HOST;
  if (!host) {
    throw new Error("MOIRA_HOST environment variable is required for build");
  }
  const protocol = host.includes("localhost") ? "http" : "https";
  return `${protocol}://${host}/mcp`;
}

// Web UI base path, configurable via the APP_BASE_PATH build-arg.
// "/" (default, self-host) → Web UI at root; "/app" (our hosted deploy) → under /app.
function getAppBasePath() {
  return process.env.APP_BASE_PATH || "/";
}

// publicPath for static assets: "/" at root, "/app/" when served under /app.
function getPublicPath() {
  return getAppBasePath() === "/" ? "/" : "/app/";
}

const config = {
  entry: "./src/index.tsx",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].[contenthash].js",
    clean: true,
    publicPath: getPublicPath(),
  },
  cache: {
    type: "filesystem",
    buildDependencies: {
      config: [__filename],
    },
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared/types": path.resolve(__dirname, "src/types"),
      types: path.resolve(__dirname, "src/types"),
      "@mcp-moira/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: "esbuild-loader",
        exclude: /node_modules/,
        options: {
          loader: "tsx",
          target: "es2020",
        },
      },
      {
        test: /\.css$/i,
        use: ["style-loader", "css-loader"],
      },
      {
        test: /\.(png|svg|jpg|jpeg|gif)$/i,
        type: "asset/resource",
      },
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/i,
        type: "asset/resource",
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: "./public/index.html",
      title: "MCP Moira Workflow Visualizer",
    }),
    new DefinePlugin({
      "process.env.MCP_URL": JSON.stringify(getMcpUrl()),
      "process.env.APP_BASE_PATH": JSON.stringify(getAppBasePath()),
    }),
  ],
  optimization: {
    splitChunks: {
      chunks: "all",
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: "vendors",
          priority: 10,
          chunks: "all",
        },
        reactflow: {
          test: /[\\/]node_modules[\\/]@xyflow[\\/]/,
          name: "reactflow",
          priority: 20,
          chunks: "all",
        },
      },
    },
  },
};

module.exports = (env, argv) => {
  const isProduction = argv.mode === "production";

  // Update CSS rule for production vs development
  config.module.rules[1] = {
    test: /\.css$/i,
    use: [
      isProduction ? MiniCssExtractPlugin.loader : "style-loader",
      "css-loader",
      "postcss-loader",
    ],
  };

  // Add MiniCssExtractPlugin for production builds
  if (isProduction) {
    // Generate hidden source maps (no sourceMappingURL in bundle)
    // .map files are generated for error analysis but not exposed to clients
    config.devtool = "hidden-source-map";
    config.optimization = {
      ...config.optimization,
      minimize: true,
    };
    config.plugins.push(
      new MiniCssExtractPlugin({
        filename: "[name].[contenthash].css",
      }),
    );
  }

  return config;
};
