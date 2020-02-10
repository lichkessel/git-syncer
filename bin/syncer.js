#!/usr/bin/env node

'use strict';

const chalk = require('chalk');
const chokidar = require('chokidar');
const path = require('path');
const cp = require('child_process');
const fs = require('fs');
const fse = require('fs-extra');
const packageJson = require('../package.json');

let command;

const program = require('commander');

program
  .command('gsync')
  .version(packageJson.version)
  .arguments(`[branch] [repository-uri]`)
  .usage(`[branch] [repository-uri]
    Creates a ${chalk.yellow('<branch>')} which will be syncronized with repository at ${chalk.yellow('<repository-uri>')} 
    ${chalk.green(chalk.bold('Without params gsync uses parameters (not options) from previous launch'))}`)
  .option('-u, --update', 'updates your remote gsync repository to master branch state')
  .option('-s, --single', 'same as --update but also puts gsync commit to master branch after quit')
  .option('-m, --master <branch>', `counts as your local working branch to which gsync branch is relative. Default: ${chalk.bold('master')}`)
  .action((branch, repositoryUri, options) => {
    let config = configuration( 
      branch, 
      repositoryUri, 
      options.update, 
      options.master,
      options.single
    );
    start(config);
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

function configuration(branch, repositoryUri, update, master, single) {
  //git config --local gsync.branch alexander
  let config = {
    update : update || single,
    single,
    master : master || 'master'
  }
  let serializable = {
    branch,
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

function prepare(dir, config, subdir) {
  let {branch, repositoryUri, update, master, single} = config;

  dir = subdir ? path.join(dir, subdir): dir;
  repositoryUri = repositoryUri ? (subdir ? path.join(repositoryUri, subdir) : repositoryUri) : "";

  process.chdir(dir);
  
  let state = {
    id : dir.replace(/^.*?([^/\\]+)$/,'$1'),
    dir : dir,
    root: subdir ? `${subdir}${path.sep}` : '',
    master: master,
    revision: check('git rev-parse HEAD'),
    containsUncommitedChanges : check('git status --porcelain'), //git diff --name-only HEAD
    repositoryUri : check(`git config --get remote.${branchOrigin}.url`),
    remoteNameWhichBranchTracks : check(`git config --get branch.${branch}.remote`),
    branchExists : check(`git rev-parse --verify ${branch}`,{stdio:['pipe','pipe','ignore']})
  }
  state.comment = `gsync:auto:commit:${branch}:${state.id}`;

  if(state.containsUncommitedChanges) {
    console.log(chalk.red(`The directory contains uncommited changes. Commit them and try again.`));
    process.exit(1);
  }

  console.log(chalk.green(`Configuring '${state.id}'...`));
  
  if(repositoryUri) {
    if(state.repositoryUri) {
      console.log(chalk.yellow(`Change remote uri of '${branchOrigin}' to '${repositoryUri}'`));
      cp.execSync(`git remote set-url ${branchOrigin} ${repositoryUri}`);
    } else {
      console.log(chalk.yellow(`Set remote '${branchOrigin}' uri to '${repositoryUri}'`));
      cp.execSync(`git remote add ${branchOrigin} ${repositoryUri}`);
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
    console.log(chalk.yellow(`Fetching changes from '${branchOrigin}' at '${state.repositoryUri || repositoryUri}'...`));
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
  return state;
}

function start(config) {
  let {branch, repositoryUri, update, master, single} = config;
  // Preparing state
  console.log(chalk.green(`Starting gsync@${packageJson.version} for '${branch}' branch...`));
  printConfig(config);
  return;
  let glob = {
    dir : check('git rev-parse --show-toplevel'),
    branch : check('git rev-parse --abbrev-ref HEAD')
  }
  let branchOrigin = `${branch}_origin`;
  let repositories = [glob.dir];
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
    repositories.push(...(modules.map(x=>path.join(glob.dir, x))));
  }

  // Preparing repositories
  let states = []
  states.push(prepare(glob.dir, config));
  for(let module of modules) {
    states.push(prepare(glob.dir, config, module));
  }

  console.log(chalk.yellow(`Installing watcher on '${glob.dir}'...`));

  // Commit request
  let committing = false;
  let commitRequest;
  function commit(state) {
    if(!committing) {
      committing = true;
      process.chdir(state.dir);
      let revision = check(`git rev-parse HEAD`);
      let replace = state.revision !== revision;
      cp.execSync('git add -A');
      cp.execSync(`git commit ${replace ? '--amend' : ''} -q -m "${state.comment}"`);
      console.log(`committed ${chalk.yellow(`${state.comment}`)}`);
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
    cwd: glob.dir,
    ignored: ['node_modules', '.git'],
    ignoreInitial: true
  })
  .on('all', (event, p) => {
    let maxCount = -1;
    let bestState = null;
    for(let state of states) {
      if(p.startsWith(state.root)) {
        if(state.root.length > maxCount) {
          maxCount = state.root.length;
          bestState = state;
        }
      }
    }
    commit(bestState); 
  })
  .on('ready', () => console.log(chalk.green('Watching... Press Q to exit.')))

  // Exit
  function quit() {
    watcher.close()
    .then(()=>{
      for(let state of states) {
        process.chdir(state.dir);
        let revision = check(`git rev-parse HEAD`);
        cp.execSync(`git checkout ${state.master}`,{stdio:'ignore'});
        console.log(chalk.green(`Switched to '${state.master}' at '${state.dir}'`))
        if(single && revision !== state.revision) {
          try {
            cp.execSync(`git rebase ${branch}`,{stdio:'ignore'});
            while(true) {
              let next = check(`git log --format=%B -n 1 head~1`);
              if(next === state.comment) {
                cp.execSync(`git reset --soft head^`,{stdio:'ignore'});
              } else {
                cp.execSync(`git commit --amend --no-edit`,{stdio:'ignore'});
                break;
              }
            }
            console.log(chalk.green(`Rebased '${state.master}' to '${branch}' at '${state.dir}'.`));
            console.log(chalk.green(`Do not forget to ${chalk.bold('--amend')} commit message.`))
          } catch(e) {
            console.log(chalk.red(`Failed to save commit to '${state.master}' at '${state.dir}'`))
          }          
        }
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