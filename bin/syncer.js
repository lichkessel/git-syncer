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

program.version(packageJson.version)
  .arguments('<branch> [repository-uri]')
  .usage(`creates a ${chalk.yellow('<branch>')} which will be syncronized with repository at ${chalk.yellow('<repository-uri>')} (you can specify the uri only once)`)
  .option('-u, --update', 'updates your remote gsync repository')
  .option('-m, --master <branch>', `counts as your local working branch to which gsync branch is relative. Default: ${chalk.bold('master')}`)
  .action((branch, repositoryUri, options) => {
    start(branch, repositoryUri, options.update, options.master);
  })
  .allowUnknownOption()
  .on('--help',()=>{
    console.log(``);
    console.log(`${chalk.red('WARNING')}: ${chalk.bold('do not commit to gsync branch.')}`);
    console.log(`All commits which are not pushed to remote will be deleted`);
    console.log(`${chalk.blue('INFO')}: normally, your gsync branch should contain only one commit`);
    console.log(``);
    console.log(chalk.blue(`- Configure server: `))
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

function prepare(dir, branch, branchOrigin, update, master, repositoryUri, subdir) {
  dir = subdir ? path.join(dir, subdir): dir;
  repositoryUri = repositoryUri ? (subdir ? path.join(repositoryUri, subdir) : repositoryUri) : "";

  process.chdir(dir);
  
  let state = {
    containsUncommitedChanges : check('git status --porcelain'), //git diff --name-only HEAD
    repositoryUri : check(`git config --get remote.${branchOrigin}.url`),
    remoteNameWhichBranchTracks : check(`git config --get branch.${branch}.remote`),
    branchExists : check(`git rev-parse --verify ${branch}`,{stdio:['pipe','pipe','ignore']})
  }

  if(state.containsUncommitedChanges) {
    console.log(chalk.red(`The directory contains uncommited changes. Commit them and try again.`));
    process.exit(1);
  }

  console.log(chalk.green(`Configuring '${dir.replace(/^.*?([^/\\]+)$/,'$1')}'...`));
  
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
}

function start(branch, repositoryUri, update, master) {
  // Preparing state
  console.log(chalk.green(`Starting gsync@${packageJson.version} for '${branch}' branch...`));
  let state = {
    dir : check('git rev-parse --show-toplevel'),
    branch : check('git rev-parse --abbrev-ref HEAD')
  }
  let branchOrigin = `${branch}_origin`;
  let repositories = [state.dir];
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
    repositories.push(...(modules.map(x=>path.join(state.dir, x))));
  }

  // Preparing repositories
  prepare(state.dir, branch, branchOrigin, update, master, repositoryUri);
  for(let module of modules) {
    prepare(state.dir, branch, branchOrigin, update, master, repositoryUri, module);
  }

  console.log(chalk.yellow(`Installing watcher on '${state.dir}'...`));

  // Commit request
  let committing = false;
  let commitRequest;
  function commit(dir) {
    if(!committing) {
      committing = true;
      const id = dir.replace(/^.*?([^/\\]+)$/,'$1');
      const comment = `gsync:auto:commit:${branch}:${id}`
      process.chdir(dir);
      cp.execSync('git add -A');
      cp.execSync(`git commit --amend -q -m "${comment}"`);
      console.log(`committed ${chalk.yellow(`${comment}`)}`);
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
    cwd: state.dir,
    ignored: ['node_modules', '.git'],
    ignoreInitial: true
  })
  .on('all', (event, p) => {
    for(let module of modules) {
      if(p.startsWith(`${module}${path.sep}`)) {
        commit(path.join(state.dir,module));
        return;
      }
    } 
    commit(state.dir);  
  })
  .on('ready', () => console.log(chalk.green('Watching... Press Q to exit.')))

  // Exit
  function quit() {
    watcher.close()
    .then(()=>{
      [state.dir, ...(modules.map(x=>path.join(state.dir, x)))].forEach((dir)=>{
        process.chdir(dir);
        let revision = check(`git rev-parse HEAD`);
        cp.execSync(`git checkout ${master}`,{stdio:'ignore'});
        console.log(chalk.green(`Switched to '${master}'`))
        if(update) {
          try {
            cp.execSync(`git cherry-pick ${revision}`,{stdio:'ignore'});
            console.log(chalk.green(`Cherry-picked commit to '${master}'. Do not forget to --amend it.`))
          } catch(e) {
            console.log(chalk.red(`Failed to cherry-pick commit to '${master}'`))
          }          
        }
      })
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