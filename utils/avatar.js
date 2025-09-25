const { exec } = require("child_process");
const path = require("path");

function runSadTalker({ imagePath, audioPath, outputPath }) {
  return new Promise((resolve, reject) => {
    const cmd = `python sad_talker.py --image ${imagePath} --audio ${audioPath} --output ${outputPath}`;
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });
}

function stitchSegments({ intro, main, outro, output }) {
  return new Promise((resolve, reject) => {
    const listPath = path.join(__dirname, "concat_list.txt");
    const listContent = `file '${intro}'\nfile '${main}'\nfile '${outro}'`;
    require("fs").writeFileSync(listPath, listContent, "utf8");

    const cmd = `ffmpeg -f concat -safe 0 -i ${listPath} -c copy ${output}`;
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { runSadTalker, stitchSegments };
