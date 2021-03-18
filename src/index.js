const fs = require('fs');
const path = require('path');
const normalizePath = require('normalize-path');
const map = require('unist-util-map');
const queryString = require('query-string');
const { getParameters } = require('codesandbox/lib/api/define');

const DEFAULT_PROTOCOL = 'embedded-codesandbox://';
const DEFAULT_EMBED_OPTIONS = {
  view: 'preview',
  hidenavigation: 1,
};
const DEFAULT_GET_IFRAME = url =>
  `<iframe src="${url}" class="embedded-codesandbox" sandbox="allow-modals allow-forms allow-popups allow-scripts allow-same-origin"></iframe>`;

const getAllFiles = dirPath =>
  fs.readdirSync(dirPath).reduce((acc, file) => {
    const relativePath = dirPath + '/' + file;
    const isDirectory = fs.statSync(relativePath).isDirectory();
    const additions = isDirectory
      ? getAllFiles(relativePath)
      : [path.join(__dirname, relativePath)];
    return [...acc, ...additions];
  }, []);

module.exports = (
  { markdownAST },
  {
    directory: rootDirectory,
    protocol = DEFAULT_PROTOCOL,
    embedOptions = DEFAULT_EMBED_OPTIONS,
    getIframe = DEFAULT_GET_IFRAME,
  }
) => {
  if (!rootDirectory) {
    throw Error('Required option "directory" not specified');
  } else if (!fs.existsSync(rootDirectory)) {
    throw Error(`Cannot find directory "${rootDirectory}"`);
  } else if (!rootDirectory.endsWith('/')) {
    rootDirectory += '/';
  }

  const getDirectoryPath = url => {
    let directoryPath = url.replace(protocol, '');
    const fullPath = path.join(rootDirectory, directoryPath);
    return normalizePath(fullPath);
  };

  const getFilesList = directory => {
    let packageJsonFound = false;
    const folderFiles = getAllFiles(directory);
    const sandboxFiles = folderFiles
      // we ignore the package.json file as it will
      // be handled separately
      .filter(file => !file.includes('package.json'))
      .map(file => {
        const fullFilePath = path.resolve(directory, file);
        const content = fs.readFileSync(fullFilePath, 'utf-8');
        return {
          name: file,
          content,
        };
      });

    let workingDir = directory;
    while (!packageJsonFound) {
      // first read all files in the folder and look
      // for a package.json there
      const files = fs.readdirSync(workingDir);
      const packageJson = getPackageJsonFile(files);
      if (packageJson) {
        const fullFilePath = path.resolve(workingDir, 'package.json');
        const content = fs.readFileSync(fullFilePath, 'utf-8');
        sandboxFiles.push({
          name: 'package.json',
          content,
        });
        packageJsonFound = true;
        // if root folder is reached, use a fallback default
        // value as content, to ensure the sandbox is always working
      } else if (path.resolve(workingDir) === path.resolve(rootDirectory)) {
        sandboxFiles.push({
          name: 'package.json',
          content: '{ "name": "example" }',
        });
        packageJsonFound = true;
        // if not present, work up the folders
      } else {
        workingDir = path.join(workingDir, '..');
      }
    }

    return sandboxFiles;
  };

  const getPackageJsonFile = fileList => {
    return fileList.find(file => file.includes('package.json'));
  };

  const createParams = files => {
    const filesObj = files.reduce((prev, current) => {
      // parse package.json first
      if (current.name.includes('package.json')) {
        prev[current.name] = { content: JSON.parse(current.content) };
      } else {
        prev[current.name] = { content: current.content };
      }
      return prev;
    }, {});
    const params = {
      files: filesObj,
    };

    return params;
  };

  const getUrlParts = url => {
    const splitUrl = url.split('?');
    return {
      base: splitUrl[0],
      query: queryString.parse(splitUrl[1]),
    };
  };

  const convertNodeToEmbedded = (node, params, options = {}) => {
    delete node.children;
    delete node.position;
    delete node.title;
    delete node.url;

    // merge the overriding options with the plugin one
    const mergedOptions = { ...embedOptions, ...options };
    const encodedEmbedOptions = encodeURIComponent(
      queryString.stringify(mergedOptions)
    );
    const sandboxUrl = `https://codesandbox.io/api/v1/sandboxes/define?embed=1&parameters=${params}&query=${encodedEmbedOptions}`;
    const embedded = getIframe(sandboxUrl);

    node.type = 'html';
    node.value = embedded;
  };

  map(markdownAST, node => {
    if (node.type === 'link' && node.url.startsWith(protocol)) {
      // split the url in base and query to allow user
      // to customise embedding options on a per-node basis
      const url = getUrlParts(node.url);
      // get all files in the folder and generate
      // the embeddeing parameters
      const dir = getDirectoryPath(url.base);
      const files = getFilesList(dir);
      const params = createParams(files);
      convertNodeToEmbedded(node, getParameters(params), url.query);
    }

    return node;
  });

  return markdownAST;
};
