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
  .action((branch, repositoryUri, options) => {
    start(branch, repositoryUri);
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
  })
  .parse(process.argv);

function start(branch, repositoryUri) {
  // Preparing state
  console.log(chalk.green(`Starting gsync@${packageJson.version} for '${branch}' branch...`));
  function check(cmd) {
    try { 
      return cp.execSync(`${cmd}`,{stdio:['pipe','pipe','ignore']}).toString().replace(/(^\s*|\s*$)/g,'')
    } catch(e) {
      return false;
    }
  }
  let branchOrigin = `${branch}_origin`;
  let state = {
    branch : check('git rev-parse --abbrev-ref HEAD'),
    dir : check('git rev-parse --show-toplevel'),
    containsUncommitedChanges : check('git status --porcelain'), //git diff --name-only HEAD
    repositoryUri : check(`git config --get remote.${branchOrigin}.url`),
    remoteNameWhichBranchTracks : check(`git config --get branch.${branch}.remote`),
    branchExists : check(`git rev-parse --verify ${branch}`,{stdio:['pipe','pipe','ignore']})
  }

  // Checking state
  if(state.containsUncommitedChanges) {
    console.log(chalk.red(`The directory contains uncommited changes. Commit them and try again.`));
    process.exit(1);
  }

  // Configure remote
  console.log(chalk.yellow(`Configuring...`));
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
  console.log(chalk.yellow(`Fetching changes from '${branchOrigin}' at '${state.repositoryUri || repositoryUri}'...`));
  cp.execSync(`git fetch ${branchOrigin}`,{stdio:'ignore'});

  // Pull changes from remote

  // Checkout branch
  function rollback() {
    try {
      cp.execSync(`git checkout ${state.branch}`,{stdio:'ignore'});
      console.log(chalk.blue(`Rolled back to '${state.branch}'`));
    } catch(e) {
      console.error(e);
      console.log(chalk.red(`WARNING: could not roll back to '${state.branch}'. You have to do it manually.`))
      process.exit(1);
    }
  }

  if(state.branchExists) {
    try {
      cp.execSync(`git checkout master`,{stdio:'ignore'});
      cp.execSync(`git branch -D ${branch}`,{stdio:'ignore'});
    } catch(e) {}
  }

  try {
    cp.execSync(`git branch ${branch} -t ${branchOrigin}/master`,{stdio:'ignore'});
    console.log(chalk.yellow(`Branch '${branch}' with origin set to '${branchOrigin}/master' re-created.`))
  } catch(e) {
    console.error(e);
    console.log(chalk.red(`Error: couldn't create branch '${branch}'.`))
    process.exit(1)
  }

  /*
  try {
    cp.execSync(`git branch -u ${branchOrigin}/master ${branch}`);
    console.log(chalk.yellow(`Branch '${branch}' origin set to '${branchOrigin}/master'.`))
  } catch(e) {
    console.error(e);
  }*/

  try {
    cp.execSync(`git checkout ${branch}`, {stdio:'ignore'}); 
    console.log(chalk.yellow(`Branch '${branch}' checked out.`))
  } catch(e) {
    console.log(chalk.red(`Error: can not checkout ${branch} branch to push changes`));
    rollback();
    process.exit(1);
  }

  console.log(chalk.yellow(`Installing watcher on '${state.dir}'...`));

  // Commit request
  let committing = false;
  let commitRequest;
  function commit() {
    if(!committing) {
      committing = true;
      const comment = `gsync:auto:commit:${branch}`
      cp.execSync('git add -A');
      cp.execSync(`git commit --amend -q -m "${comment}"`);
      console.log(`committed ${chalk.yellow(`${comment}`)}`);
      cp.execSync(`git push ${branchOrigin} ${branch}:master --force -q`,{stdio:'ignore'});
      console.log(`pushed to ${chalk.yellow(`${branchOrigin}`)}`);
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
  chokidar.watch('.', {
    cwd: state.dir,
    ignored: ['node_modules', '.git'],
    ignoreInitial: true
  })
  .on('all', (event, path) => {
    commit();
  })
  .on('ready', () => console.log(chalk.green('Watching... ')))
}