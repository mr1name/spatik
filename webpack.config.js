var path = require('path');

module.exports = {
  mode: 'production',
  watch: true,
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  entry: {
    index: './src/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/js'),
    filename: '[name].bundle.js'
  },
  optimization: {
    concatenateModules: false,
    splitChunks: {
      // include all types of chunks
      // chunks: 'all'
    }
  },
};