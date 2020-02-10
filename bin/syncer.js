#!/usr/bin/env node

'use strict';

const chalk = require('chalk');
const chokidar = require('chokidar');
const path = require('path');
const cp = require('child_process');
const fs = require('fs');
const fse = require('fs-extra');
const packageJson = require('../package.json');

const commander = require('commander');
const program = new commander.Command('gsync');

program
  .version(packageJson.version)
  .arguments(`[branch] [repository-uri]`)
  .usage(`[branch] [repository-uri]
    Creates a ${chalk.yellow('<branch>')} which will be syncronized with repository at ${chalk.yellow('<repository-uri>')} 
    ${chalk.green(chalk.bold('Without params gsync uses parameters (not options) from previous launch'))}`)
  .option('-u, --update', 'updates your remote gsync repository to master branch state')
  .option('-p, --pull', 'pulls changes from gsync branch to master branch')
  .option('-m, --master <branch>', `counts as your local working branch to which gsync branch is relative. Default: ${chalk.bold('master')}`)
  .option('--test', 'test')
  .action((branch, repositoryUri, options) => {
    let config = configuration( 
      branch, 
      repositoryUri, 
      options.update, 
      options.master,
      options.pull
    );
    if(options.test) {
      test(config);
    } else {
      start(config);
    }   
  })
  .allowUnknownOption()
  .on('--help',()=>{
    console.log(``);
    console.log(`${chalk.red('WARNING')}: ${chalk.bold('do not manually commit to gsync branch.')}`);
    console.log(`All commits which are not pushed to remote will be deleted`);
    console.log(`${chalk.blue('INFO')}: normally, your gsync branch should contain only one generated commit`);
    console.log(``);
    console.log(chalk.blue(`- Configure server manually: `))
    console.log(`  In the remote repository: `);
    console.log(chalk.bold(`  git config --local receive.denyCurrentBranch updateInstead`));
    console.log(`  Consider this repository as ${chalk.red('read-only')}.`);
    console.log(`  Make sure this repository has ${chalk.bold('master')} branch checked out:`);
    console.log(chalk.bold(`  git status`));
    console.log(`  ${chalk.yellow('ATENTION')}: git version should be >= 2.16.x`);
    console.log(`  ${chalk.red('WARNING')}: Do not use this server repository other than for gsync`);
    console.log(``);
    console.log(chalk.blue(`- Push changes to master as a single(squashed) commit: `));
    console.log(chalk.bold(`  git checkout master && git merge --squash -m "<commit message>" <gsync_branch>`));
    console.log(``);
    console.log(chalk.blue(`- Squash all commits in the branch: `));
    console.log(chalk.bold(`  git rebase -i HEAD~N`));
    console.log(`  where N is a number of commits to squash stating from the current.`);
    console.log(`  This command opens interactive dialog for squashing commits.`);
    console.log(``);
    console.log(chalk.blue(`Examples: `));
    console.log(`gsync alexander rt.com:/var/www/html/alexander`);
    console.log(`gsync alexander`);
  })
  .parse(process.argv);

function check(cmd) {
  try { 
    return cp.execSync(`${cmd}`,{stdio:['pipe','pipe','ignore']}).toString().replace(/(^\s*|\s*$)/g,'')
  } catch(e) {
    return false;
  }
}

function configuration(branch, repositoryUri, update, master, pull) {
  //git config --local gsync.branch alexander
  let config = {
    update,
    pull,
    master : master || 'master',
    dir : check('git rev-parse --show-toplevel')
  }
  let serializable = {
    branch,
    branchOrigin: `${branch}_origin`,
    repositoryUri
  }
  let localConfig = {}
  for(let name in serializable) {
    localConfig[name] = check(`git config --get gsync.${name}`);
  }
  for(let name in localConfig) {
    localConfig[name] = localConfig[name] ==='true' ? true : 
      (localConfig[name] === 'false' ? false : 
        (localConfig[name] ? localConfig[name] : undefined ))
  }
  for(let name in serializable) {
    if(serializable[name] === undefined) {
      serializable[name] = localConfig[name];
    }
  }
  for(let name in serializable) {
    if(serializable[name] !== undefined) {
      cp.execSync(`git config --local gsync.${name} ${serializable[name].toString()}`,{stdio:'ignore'});
    }
  }
  for(let name in serializable) {
    config[name] = serializable[name];
  }
  return config;
}

function prepare( repository, config ) {
  let { branch, branchOrigin, repositoryUri, update, master, single } = config;
  let { dir, module } = repository;

  process.chdir(dir);
  
  let state = repository.state = {
    revision: check('git rev-parse HEAD'),
    containsUncommitedChanges : check('git status --porcelain'), //git diff --name-only HEAD
    repositoryUri : check(`git config --get remote.${branchOrigin}.url`),
    remoteNameWhichBranchTracks : check(`git config --get branch.${branch}.remote`),
    branchExists : check(`git rev-parse --verify ${branch}`,{stdio:['pipe','pipe','ignore']})
  }
  repository.id = dir.replace(/^.*?([^/\\]+)$/,'$1');
  repository.master = master;
  repository.root = module ? `${module}${path.sep}` : '';
  repository.uri = repositoryUri = repositoryUri ? (module ? path.join(repositoryUri, module) : repositoryUri) : "";

  state.comment = `gsync:auto:commit:${branch}:${repository.id}`;

  if(state.containsUncommitedChanges) {
    console.log(chalk.red(`The directory contains uncommited changes. Commit them and try again.`));
    process.exit(1);
  }

  console.log(chalk.green(`Configuring '${repository.id}'...`));
  
  if(repository.uri) {
    if(state.repositoryUri) {
      console.log(chalk.yellow(`Change remote uri of '${branchOrigin}' to '${repository.uri}'`));
      cp.execSync(`git remote set-url ${branchOrigin} ${repository.uri}`);
    } else {
      console.log(chalk.yellow(`Set remote '${branchOrigin}' uri to '${repository.uri}'`));
      cp.execSync(`git remote add ${branchOrigin} ${repository.uri}`);
    }
  } else {
    if(state.repositoryUri) {
      console.log(chalk.yellow(`Remote uri of ${branchOrigin} is '${state.repositoryUri}'`));
    } else {
      console.log(chalk.red(`Remote target is not configured. Specify repository URI and run command again.`));
      process.exit(1);
    }
  }

  try {
    cp.execSync(`git checkout ${master}`,{stdio:'ignore'});
  } catch(e) {}

  if(state.branchExists) {
    try {
      cp.execSync(`git branch -D ${branch}`,{stdio:'ignore'});
    } catch(e) {}
  }

  // Checkout branch
  if(update) {
    try {
      cp.execSync(`git branch ${branch}`,{stdio:'ignore'});
    } catch(e) {
      console.log(chalk.red(`Error: can not create '${branch}'' branch`));
      process.exit(1);
    }
    try {
      cp.execSync(`git push -u ${branchOrigin} ${branch}:master --force`,{stdio:'ignore'});
      cp.execSync(`git checkout ${branch}`, {stdio:'ignore'});
      console.log(chalk.yellow(`Branch '${branchOrigin}/master' updated to recent '${master}'.`));
    } catch(e) {
      console.log(chalk.red(`Error: can not checkout '${branch}'' branch to push changes`));
      process.exit(1);
    }    
  } else {
    console.log(chalk.yellow(`Fetching changes from '${branchOrigin}' at '${state.repositoryUri || repository.uri}'...`));
    cp.execSync(`git fetch ${branchOrigin}`,{stdio:'ignore'});
    try {
      cp.execSync(`git branch ${branch} -t ${branchOrigin}/master`,{stdio:'ignore'});
      console.log(chalk.yellow(`Branch '${branch}' with origin set to '${branchOrigin}/master' re-created.`))
    } catch(e) {
      console.error(e);
      console.log(chalk.red(`Error: couldn't create branch '${branch}'.`))
      process.exit(1)
    }
    try {
      cp.execSync(`git checkout ${branch}`, {stdio:'ignore'}); 
      console.log(chalk.yellow(`Branch '${branch}' checked out.`))
    } catch(e) {
      console.log(chalk.red(`Error: can not checkout '${branch}'' branch to push changes`));
      process.exit(1);
    }
  }
}

function start(config) {
  let {branch, branchOrigin, repositoryUri, update, master, pull} = config;
  // Preparing state
  console.log(chalk.green(`Starting gsync@${packageJson.version} for '${branch}' branch...`));
  printConfig(config);
  let glob = {
    branch : check('git rev-parse --abbrev-ref HEAD')
  }
  let repositories = [{
    dir: config.dir,
    module: ''
  }];
  let modules = [];
  try {
    modules = cp.execSync('git config --file .gitmodules --get-regexp path')
      .toString()
      .split('\n')
      .map(x=>x.replace(/(^\s*|\s*$)/g,''))
      .filter(x=>!!x)
      .map(x=>x.replace(/^submodule\..+?\.path (.+)$/,'$1'))
    //submodule.az.path az
    //submodule.az2.path az2
  } catch(e) {}
  if(modules.length) {
    console.log(chalk.yellow(`Found submodules: ${modules.join(', ')}.`));
    repositories.push(...(modules.map((module)=>{
      return {
        dir: path.join(config.dir, module),
        module: module
      }
    })));
  }

  // Preparing repositories
  for(let repository of repositories) {
    prepare(repository, config);
  }
  //let states = []
  //states.push(prepare(config.dir, config));
  //for(let module of modules) {
  //  states.push(prepare(config.dir, config, module));
  //}

  if(config.pull) {
    pull(repositories, config);
    return;
  }

  console.log(chalk.yellow(`Installing watcher on '${config.dir}'...`));

  // Commit request
  let committing = false;
  let commitRequest;
  function commit(repository) {
    if(!committing) {
      committing = true;
      process.chdir(repository.dir);
      let revision = check(`git rev-parse HEAD`);
      let replace = repository.state.revision !== revision;
      cp.execSync('git add -A');
      cp.execSync(`git commit ${replace ? '--amend' : ''} -q -m "${repository.comment}"`);
      console.log(`committed ${chalk.yellow(`${repository.comment}`)}`);
      try {
        cp.execSync(`git push ${branchOrigin} ${branch}:master --force -q`,{stdio:'ignore'});
        console.log(`pushed to ${chalk.yellow(`${branchOrigin}`)}`);
      } catch(e) {
        console.log(chalk.red(`Failed to push changes.`))
        console.log(chalk.red(`Perhaps, you've forgotten to configure server repositories with:`))
        console.log(chalk.bold(`git config --local receive.denyCurrentBranch updateInstead`))
        console.error(e);
        quit()
      }
      committing = false;
    } else {
      if(commitRequest) {
        clearTimeout(commitRequest);
      }
      commitRequest = setTimeout(()=>{commitRequest = null; commit(); }, 200);
    }
  }

  // Watcher
  let commitJob;
  let watcher = chokidar.watch('.', {
    cwd: config.dir,
    ignored: ['node_modules', '.git'],
    ignoreInitial: true
  })
  .on('all', (event, p) => {
    let maxCount = -1;
    let bestState = null;
    for(let repository of repositories) {
      if(p.startsWith(repository.root)) {
        if(repository.root.length > maxCount) {
          maxCount = repository.root.length;
          bestState = repository;
        }
      }
    }
    commit(repository); 
  })
  .on('ready', () => console.log(chalk.green('Watching... Press Q to exit.')))

  // Exit
  function quit() {
    watcher.close()
    .then(()=>{
      for(let repository of repositories) {
        process.chdir(repository.dir);
        cp.execSync(`git checkout ${repository.master}`,{stdio:'ignore'});
        console.log(chalk.green(`Switched to '${repository.master}' at '${repository.dir}'`))
      }
      process.exit();
    })
  }
  const readline = require('readline');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key.name === 'q') {
      quit()
    }
  });
}

function pull(repositories, config) {
  let { branch } = config;
  for(let repository of repositories) {
    process.chdir(repository.dir);
    let revision = check(`git rev-parse ${repository.master}`);
    try {
      cp.execSync(`git reset --soft ${revision}`,{stdio:'ignore'});
      console.log(chalk.green(`Changes staged to '${repository.master}' from '${branch}' at '${repository.dir}'.`));
      console.log(chalk.green(`Do not forget to ${chalk.bold('git commit')} the changes.`))
      cp.execSync(`git checkout ${repository.master}`,{stdio:'ignore'});
      console.log(chalk.green(`Switched to '${repository.master}' at '${repository.dir}'`))
    } catch(e) {
      console.log(chalk.red(`Failed to save commit to '${repository.master}' at '${repository.dir}'`))
    }
  }
}

function printConfig(config) {
  let str = [];
  console.log(chalk.green('Launch configuration:'))
  for(let name in config) {
    if(config[name] !== undefined) {
      str.push(`${name}: ${config[name]}`)
    }
  }
  console.log(chalk.yellow(str.join(' | ')))
}

function lockGit() {

}

function unlockGit() {

}

function lockApp() {

}

function unlockApp() {

}

function test() {
  let glob = {
    dir : check('git rev-parse --show-toplevel')
  }
  let watcher = chokidar.watch('.git', {
    cwd: glob.dir,
    ignoreInitial: true
  })
  .on('add', (p) => {//
    console.log(p); 
  })
  .on('ready', () => console.log(chalk.green('.git files watching...')))
}